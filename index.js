/**
 * dsh-plugin-wrapped — a DeepSeek Harness plugin that produces a NetEase-style
 * monthly / quarterly / yearly rewind of human-vs-AI conversations.
 *
 * Form: a host-side Cordis plugin (no client bundle, no build step) that
 *   1. collects history automatically through `ctx.sessionQuery` — every
 *      durable session log already on this machine, live or persisted;
 *   2. derives the report in-process with a TTL cache (no database, no new
 *      storage, no import step);
 *   3. publishes it on the GUI's own web server: `/wrapped` renders the report
 *      and `/api/wrapped` serves the same numbers as JSON. A floating launcher
 *      link is added to the GUI shell via `webServer.tapIndex`.
 *
 * The model never sees any of this: no tools, no prompt, no KV-cache effect.
 */

import { createRewindService } from './lib/service.js';
import { registerRewindRoutes } from './lib/http.js';

/** Cordis plugin name. */
export const name = 'rewind';

/**
 * Both services must exist before the plugin does anything useful: the query
 * service is the data source, the web server is where the report is published.
 * The fiber stays pending until both are composed.
 */
export const inject = ['sessionQuery', 'webServer'];

const DEFAULT_OPTIONS = Object.freeze({
  path: '/wrapped',
  apiPath: '/api/wrapped',
  language: 'zh',
  launcher: true,
  launcherLabel: '年度回顾',
  maxSessions: 800,
  concurrency: 4,
  cacheTtlMs: 60_000,
  logErrors: true,
});

function normalizeRoutePath(value, fallback, field) {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : fallback;
  if (!raw.startsWith('/')) throw new Error(`${field} must start with "/" (got "${raw}")`);
  const trimmed = raw.length > 1 && raw.endsWith('/') ? raw.slice(0, -1) : raw;
  if (/\s/.test(trimmed)) throw new Error(`${field} must not contain whitespace (got "${trimmed}")`);
  return trimmed;
}

function positiveInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const truncated = Math.trunc(n);
  if (truncated < min) return fallback;
  return Math.min(truncated, max);
}

/**
 * Validate + default the plugin config. Kept as a plain function (no
 * schemastery dependency) so the package installs with zero dependencies.
 */
export function normalizeOptions(config = {}) {
  const raw = config && typeof config === 'object' ? config : {};
  const path = normalizeRoutePath(raw.path, DEFAULT_OPTIONS.path, 'path');
  const apiPath = normalizeRoutePath(raw.apiPath, DEFAULT_OPTIONS.apiPath, 'apiPath');
  if (path === apiPath) throw new Error('path and apiPath must differ');
  const language = String(raw.language ?? DEFAULT_OPTIONS.language).toLowerCase().startsWith('en') ? 'en' : 'zh';
  return {
    path,
    apiPath,
    language,
    launcher: raw.launcher !== false,
    launcherLabel: typeof raw.launcherLabel === 'string' && raw.launcherLabel.trim()
      ? raw.launcherLabel.trim()
      : DEFAULT_OPTIONS.launcherLabel,
    maxSessions: positiveInt(raw.maxSessions, DEFAULT_OPTIONS.maxSessions, { min: 1, max: 20_000 }),
    concurrency: positiveInt(raw.concurrency, DEFAULT_OPTIONS.concurrency, { min: 1, max: 16 }),
    cacheTtlMs: positiveInt(raw.cacheTtlMs, DEFAULT_OPTIONS.cacheTtlMs, { min: 0, max: 24 * 60 * 60 * 1000 }),
    logErrors: raw.logErrors !== false,
  };
}

/**
 * Mount the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx - registrant context
 * @param {object} [config] - plugin config from the profile patch layer
 * @returns {() => void} disposer (also an effect on the fiber)
 */
export function apply(ctx, config = {}) {
  const options = normalizeOptions(config);
  const service = createRewindService(ctx, options);

  const mount = () => registerRewindRoutes(ctx, service, options);
  let dispose;
  if (typeof ctx.effect === 'function') {
    dispose = ctx.effect(mount);
  } else {
    dispose = mount();
    ctx.on?.('dispose', () => dispose?.());
  }

  try {
    ctx.logger?.(`rewind: conversation rewind ready at ${options.path} (api: ${options.apiPath})`);
  } catch {
    /* logging must never break mounting */
  }

  return dispose;
}

/** Exposed for embedding (CLI, tests, or another plugin). */
export { createRewindService } from './lib/service.js';
export { buildReport } from './lib/aggregate.js';
export { renderReport } from './lib/report.js';
export { extractSession } from './lib/extract.js';
export { loadFactsFromArchive, loadFactsFromSessionQuery } from './lib/sources.js';
export { resolvePeriod, buildSeries } from './lib/periods.js';
