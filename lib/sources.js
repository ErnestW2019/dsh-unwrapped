/**
 * Data sources for the rewind report.
 *
 * Two adapters produce the same `facts` array:
 *  - `loadFactsFromSessionQuery` — the live harness path (`ctx.sessionQuery`),
 *    live-preferred and replay-validated; this is what makes history collection
 *    automatic with no import step and no extra storage.
 *  - `loadFactsFromArchive` — the offline path over `$DSH_HOME/sessions`, used by
 *    the CLI and by tests.
 */

import { extractSession } from './extract.js';
import { readArchive } from './archive.js';

const DEFAULT_MAX_SESSIONS = 800;
const DEFAULT_CONCURRENCY = 4;

/** Run `worker` over `items` with bounded concurrency, preserving order. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.trunc(Number(limit) || 1));
  const runners = new Array(Math.min(size, items.length)).fill(null).map(async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function sortNewestFirst(records) {
  return [...records].sort((a, b) => {
    const aCreated = Number(a?.header?.createdAt ?? a?.session?.createdAt ?? 0);
    const bCreated = Number(b?.header?.createdAt ?? b?.session?.createdAt ?? 0);
    return bCreated - aCreated;
  });
}

/**
 * Collect facts from the live session query service.
 * @param {{ listSessions: Function, readSession: Function }} sessionQuery
 * @param {{ maxSessions?: number, concurrency?: number, onError?: (err: Error, id: string) => void }} [options]
 */
async function loadFactsFromSessionQuery(sessionQuery, options = {}) {
  const { maxSessions = DEFAULT_MAX_SESSIONS, concurrency = DEFAULT_CONCURRENCY, onError } = options;
  if (!sessionQuery || typeof sessionQuery.listSessions !== 'function' || typeof sessionQuery.readSession !== 'function') {
    throw new Error('sessionQuery service is unavailable');
  }
  const listed = sortNewestFirst(await sessionQuery.listSessions());
  const selected = listed.slice(0, Math.max(1, maxSessions));
  const facts = await mapLimit(selected, concurrency, async (record) => {
    const id = record?.header?.id ?? record?.session?.id ?? null;
    if (!id) return null;
    try {
      const snapshot = await sessionQuery.readSession(id);
      return extractSession(snapshot);
    } catch (err) {
      if (onError) onError(err, id);
      return null;
    }
  });
  return facts.filter(Boolean);
}

/**
 * Collect facts straight from an on-disk archive.
 * @param {string} root - `$DSH_HOME/sessions`
 * @param {{ maxSessions?: number, onError?: (err: Error, id: string) => void }} [options]
 */
function loadFactsFromArchive(root, options = {}) {
  const { maxSessions = DEFAULT_MAX_SESSIONS, onError } = options;
  const sessions = readArchive(root, {
    limit: maxSessions,
    onError: (err, entry) => onError?.(err, entry?.id ?? ''),
  });
  return sessions.map((session) => extractSession(session)).filter(Boolean);
}

/**
 * Small TTL cache so a burst of report requests does not re-read every log.
 * In-memory only: no database, no extra storage.
 */
function createFactsCache(loader, { ttlMs = 60_000, now = () => Date.now() } = {}) {
  let value = null;
  let loadedAt = 0;
  let inflight = null;
  return {
    async get() {
      if (value && now() - loadedAt < ttlMs) return value;
      if (inflight) return inflight;
      inflight = (async () => {
        try {
          const next = await loader();
          value = next;
          loadedAt = now();
          return next;
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    },
    /** Serve the last good value while refreshing in the background. */
    stale() {
      return value;
    },
    invalidate() {
      value = null;
      loadedAt = 0;
    },
  };
}

export {
  mapLimit,
  loadFactsFromSessionQuery,
  loadFactsFromArchive,
  createFactsCache,
  DEFAULT_MAX_SESSIONS,
};
