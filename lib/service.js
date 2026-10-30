/**
 * The rewind service: one process-local facts cache in front of
 * `ctx.sessionQuery`, and report construction from it. No database, no extra
 * storage — every number is derived from logs the harness already keeps.
 */

import { buildReport } from './aggregate.js';
import { createFactsCache, loadFactsFromSessionQuery } from './sources.js';

/**
 * @param {{ sessionQuery: object, logger?: Function }} ctx
 * @param {object} options normalized plugin options
 */
function createRewindService(ctx, options) {
  const cache = createFactsCache(
    () => loadFactsFromSessionQuery(ctx.sessionQuery, {
      maxSessions: options.maxSessions,
      concurrency: options.concurrency,
      onError: (err, id) => {
        if (options.logErrors !== false) {
          try {
            ctx.logger?.('rewind: failed to read session %s: %s', id, err?.message ?? err);
          } catch {
            /* logging must never break a report */
          }
        }
      },
    }),
    { ttlMs: options.cacheTtlMs },
  );

  return {
    /** Facts for the whole corpus, served from the TTL cache. */
    async getFacts() {
      try {
        return await cache.get();
      } catch (err) {
        const stale = cache.stale();
        if (stale) return stale;
        throw err;
      }
    },
    /** Build one period report. */
    async getReport(query = {}) {
      const facts = await this.getFacts();
      return buildReport(facts, {
        period: query.period,
        key: query.key,
        offsetMinutes: query.offsetMinutes,
        nowMs: query.nowMs,
      });
    },
    invalidate() {
      cache.invalidate();
    },
    stats() {
      const value = cache.stale();
      return { cached: Boolean(value), sessions: Array.isArray(value) ? value.length : 0 };
    },
  };
}

export { createRewindService };
