/**
 * Offline reader for the durable session archive.
 *
 * The store writes one Zstandard frame per flush into a single
 * `session.vN.jsonl.zstd` artifact, so a log is a concatenation of frames —
 * `zstdDecompressSync` alone only returns the first one. The frame walker
 * below skips each frame exactly (RFC 8878 header + block chain), which keeps
 * decompression one-shot per frame and survives a writer that was interrupted
 * mid-append (the partial tail frame is dropped, everything before it is kept).
 *
 * This reader is what makes "collect history automatically" work without a
 * running harness: the plugin's CLI and tests use it, while the live plugin
 * prefers `ctx.sessionQuery`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const LOG_NAME = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/;

function hasZstd() {
  return typeof zlib.zstdDecompressSync === 'function';
}

function isZstdFrame(buf, offset) {
  return (
    buf[offset] === ZSTD_MAGIC[0]
    && buf[offset + 1] === ZSTD_MAGIC[1]
    && buf[offset + 2] === ZSTD_MAGIC[2]
    && buf[offset + 3] === ZSTD_MAGIC[3]
  );
}

/**
 * Byte offset just past the Zstandard frame starting at `start`.
 * Throws when the frame is truncated or not a frame at all.
 */
function frameEnd(buffer, start) {
  if (!isZstdFrame(buffer, start)) throw new Error(`not a zstd frame at ${start}`);
  let pos = start + 4;
  if (pos >= buffer.length) throw new Error('truncated frame header');
  const descriptor = buffer[pos];
  pos += 1;
  const contentSizeFlag = descriptor >> 6;
  const singleSegment = (descriptor >> 5) & 1;
  const checksumFlag = (descriptor >> 2) & 1;
  const dictionaryFlag = descriptor & 3;
  if (!singleSegment) pos += 1; // Window_Descriptor
  pos += [0, 1, 2, 4][dictionaryFlag];
  pos += [singleSegment ? 1 : 0, 2, 4, 8][contentSizeFlag];
  if (pos > buffer.length) throw new Error('truncated frame header');
  for (;;) {
    if (pos + 3 > buffer.length) throw new Error('truncated block header');
    const header = buffer[pos] | (buffer[pos + 1] << 8) | (buffer[pos + 2] << 16);
    pos += 3;
    const lastBlock = header & 1;
    const blockType = (header >> 1) & 3;
    const blockSize = header >> 3;
    if (blockType === 1) {
      // RLE block: one literal byte, expanded to blockSize by the decoder.
      pos += 1;
    } else {
      pos += blockSize;
    }
    if (pos > buffer.length) throw new Error('truncated block payload');
    if (lastBlock) break;
  }
  if (checksumFlag) pos += 4;
  if (pos > buffer.length) throw new Error('truncated frame checksum');
  return pos;
}

/**
 * Split a `.zstd` buffer into frames.
 * @returns {{ frames: {start:number,end:number}[], trailingBytes: number }}
 */
function splitZstdFrames(buffer) {
  const frames = [];
  let pos = 0;
  while (pos < buffer.length) {
    // Skip a stray byte run (e.g. a torn length prefix) until the next frame.
    if (!isZstdFrame(buffer, pos)) break;
    let end;
    try {
      end = frameEnd(buffer, pos);
    } catch {
      break;
    }
    frames.push({ start: pos, end });
    pos = end;
  }
  return { frames, trailingBytes: buffer.length - pos };
}

/** Decompress every frame of one `.zstd` buffer and concatenate the text. */
function decompressLogBuffer(buffer) {
  if (!hasZstd()) throw new Error('this Node build has no zstd support (need node >= 22.15)');
  const { frames, trailingBytes } = splitZstdFrames(buffer);
  const parts = [];
  for (const frame of frames) {
    const slice = buffer.subarray(frame.start, frame.end);
    parts.push(zlib.zstdDecompressSync(slice).toString('utf8'));
  }
  return { text: parts.join(''), frameCount: frames.length, trailingBytes };
}

/** Parse JSONL text into rows, dropping blank lines and unparsable tails. */
function parseRows(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // A torn final row is expected after a crash; skip it and keep the rest.
    }
  }
  return rows;
}

/** Rows → `{ header, events }` where the header is the leading `session` row. */
function rowsToSession(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const headerIndex = rows.findIndex((row) => row && row.type === 'session');
  if (headerIndex < 0) return null;
  const header = rows[headerIndex];
  const events = rows.filter((row, index) => index !== headerIndex && row && typeof row.type === 'string');
  return { header, events };
}

/** Read one log artifact (`.jsonl` or `.jsonl.zstd`) into a session snapshot. */
function readSessionLogFile(filePath) {
  const buffer = readFileSync(filePath);
  const text = filePath.endsWith('.zstd')
    ? decompressLogBuffer(buffer).text
    : buffer.toString('utf8');
  return rowsToSession(parseRows(text));
}

/** Pick the highest-version (then newest) log artifact inside a session dir. */
function pickLogFile(dir, files) {
  const candidates = files
    .map((name) => ({ name, match: LOG_NAME.exec(name) }))
    .filter((entry) => entry.match)
    .map((entry) => ({
      name: entry.name,
      version: Number(entry.match[1] ?? 0),
      mtime: safeMtime(join(dir, entry.name)),
    }))
    .sort((a, b) => b.version - a.version || b.mtime - a.mtime);
  return candidates.length ? join(dir, candidates[0].name) : null;
}

function safeMtime(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * List every session log in an archive root.
 * Layout: `<root>/<workspace-slug>/<session-id>/session.vN.jsonl[.zstd]`.
 * @returns {{ id: string, dir: string, logPath: string }[]}
 */
function listArchiveSessions(root) {
  const out = [];
  let workspaces = [];
  try {
    workspaces = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return out;
  }
  for (const workspace of workspaces) {
    const workspaceDir = join(root, workspace.name);
    let sessionDirs = [];
    try {
      sessionDirs = readdirSync(workspaceDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      continue;
    }
    for (const sessionDir of sessionDirs) {
      const dir = join(workspaceDir, sessionDir.name);
      let files = [];
      try {
        files = readdirSync(dir);
      } catch {
        continue;
      }
      const logPath = pickLogFile(dir, files);
      if (!logPath) continue;
      out.push({ id: sessionDir.name, dir, logPath });
    }
  }
  return out;
}

/**
 * Read every session in an archive root.
 * @param {string} root
 * @param {{ limit?: number, onError?: (err: Error, entry: object) => void }} [options]
 * @returns {{ header: object, events: object[] }[]}
 */
function readArchive(root, { limit, onError } = {}) {
  const entries = listArchiveSessions(root);
  const capped = Number.isFinite(limit) && limit > 0 ? entries.slice(0, limit) : entries;
  const sessions = [];
  for (const entry of capped) {
    try {
      const session = readSessionLogFile(entry.logPath);
      if (session) sessions.push(session);
    } catch (err) {
      if (onError) onError(err, entry);
    }
  }
  return sessions;
}

export {
  ZSTD_MAGIC,
  hasZstd,
  isZstdFrame,
  frameEnd,
  splitZstdFrames,
  decompressLogBuffer,
  parseRows,
  rowsToSession,
  readSessionLogFile,
  listArchiveSessions,
  readArchive,
};
