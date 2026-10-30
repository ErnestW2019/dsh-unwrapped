import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

import {
  splitZstdFrames,
  decompressLogBuffer,
  parseRows,
  rowsToSession,
  listArchiveSessions,
  readArchive,
  hasZstd,
} from '../lib/archive.js';

const skipWithoutZstd = hasZstd() ? false : 'node build has no zstd support';

function zstdFrame(text) {
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
}

function makeArchive() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-wrapped-'));
  const workspace = join(root, '--work-demo--');
  const sessionA = join(workspace, 'session-a');
  const sessionB = join(workspace, 'session-b');
  mkdirSync(sessionA, { recursive: true });
  mkdirSync(sessionB, { recursive: true });

  const header = { type: 'session', version: 3, id: 'session-a', createdAt: 1780000000000, cwd: '/work/demo' };
  const rowsA = [
    JSON.stringify(header),
    JSON.stringify({ type: 'user/message', seq: 1, time: 1780000001000, data: {} }),
    JSON.stringify({ type: 'assistant/message', seq: 2, time: 1780000002000, data: {} }),
  ];
  // One frame per flush, concatenated — the real on-disk shape.
  const frames = rowsA.map((row) => zstdFrame(`${row}\n`));
  writeFileSync(join(sessionA, 'session.v3.jsonl.zstd'), Buffer.concat(frames));

  const rowsB = [
    JSON.stringify({ type: 'session', version: 3, id: 'session-b', createdAt: 1780000000000 }),
    JSON.stringify({ type: 'user/message', seq: 1, time: 1780000001000, data: {} }),
  ];
  writeFileSync(join(sessionB, 'session.v3.jsonl'), `${rowsB.join('\n')}\n`);

  return { root, sessionA, sessionB };
}

describe('archive: zstd framing', { skip: skipWithoutZstd }, () => {
  it('splits concatenated frames exactly', () => {
    const buffer = Buffer.concat([zstdFrame('one\n'), zstdFrame('two\n'), zstdFrame('three\n')]);
    const { frames, trailingBytes } = splitZstdFrames(buffer);
    assert.equal(frames.length, 3);
    assert.equal(trailingBytes, 0);
    assert.equal(frames[0].start, 0);
    assert.equal(frames[2].end, buffer.length);
  });

  it('decompresses every frame, not just the first', () => {
    const buffer = Buffer.concat([zstdFrame('{"a":1}\n'), zstdFrame('{"b":2}\n')]);
    const { text, frameCount } = decompressLogBuffer(buffer);
    assert.equal(frameCount, 2);
    assert.equal(text, '{"a":1}\n{"b":2}\n');
  });

  it('drops a torn trailing frame but keeps the committed prefix', () => {
    const buffer = Buffer.concat([zstdFrame('{"a":1}\n'), zstdFrame('{"b":2}\n'), Buffer.from([0x28, 0xb5, 0x2f])]);
    const { frames, trailingBytes } = splitZstdFrames(buffer);
    assert.equal(frames.length, 2);
    assert.equal(trailingBytes, 3);
    assert.equal(parseRows(decompressLogBuffer(buffer).text).length, 2);
  });
});

describe('archive: row parsing', () => {
  it('skips blank and torn lines', () => {
    const rows = parseRows('{"a":1}\n\nnot json\n{"b":2}\n');
    assert.deepEqual(rows, [{ a: 1 }, { b: 2 }]);
  });

  it('finds the header wherever it sits and keeps the remaining events', () => {
    const session = rowsToSession([
      { type: 'user/message', time: 1 },
      { type: 'session', id: 'x' },
      { type: 'assistant/message', time: 2 },
    ]);
    assert.equal(session.header.id, 'x');
    assert.deepEqual(session.events.map((event) => event.type), ['user/message', 'assistant/message']);
  });

  it('returns null when there is no session header', () => {
    assert.equal(rowsToSession([{ type: 'user/message' }]), null);
    assert.equal(rowsToSession([]), null);
  });
});

describe('archive: archive reading', { skip: skipWithoutZstd }, () => {
  it('lists sessions across workspaces and prefers the newest format version', () => {
    const { root, sessionA } = makeArchive();
    try {
      writeFileSync(join(sessionA, 'session.v2.jsonl.zstd'), zstdFrame('{"type":"session","id":"old"}\n'));
      const entries = listArchiveSessions(root);
      assert.equal(entries.length, 2);
      const a = entries.find((entry) => entry.id === 'session-a');
      assert.match(a.logPath, /session\.v3\.jsonl\.zstd$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads both compressed and plaintext logs', () => {
    const { root } = makeArchive();
    try {
      const sessions = readArchive(root);
      assert.equal(sessions.length, 2);
      const a = sessions.find((session) => session.header.id === 'session-a');
      assert.deepEqual(a.events.map((event) => event.type), ['user/message', 'assistant/message']);
      const b = sessions.find((session) => session.header.id === 'session-b');
      assert.equal(b.events.length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns an empty list for a missing root', () => {
    assert.deepEqual(listArchiveSessions(join(tmpdir(), 'definitely-not-there-xyz')), []);
  });
});
