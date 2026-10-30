/**
 * HTTP surface of the plugin: the report page and its JSON API, registered on
 * the host's existing web server (`ctx.webServer`). Registering routes on the
 * composed server — instead of shipping a second listener — keeps the plugin on
 * the same origin, port, and lifecycle as the GUI, with no CORS and no extra
 * process.
 *
 * Also adds one floating launcher link to the GUI's index.html through
 * `tapIndex`, which is the documented escape hatch for markup that no
 * `webserver/index-inject` row expresses.
 */

import { buildReport } from './aggregate.js';
import { normalizeOffsetMinutes } from './periods.js';
import { renderReport } from './report.js';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function hostOffsetMinutes() {
  return -new Date().getTimezoneOffset();
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(html),
  });
  res.end(html);
}

/** Read `period` / `key` / `tz` / `partial` from a request URL. */
function parseQuery(reqUrl, fallbackOffset, headers = null) {
  const url = new URL(String(reqUrl || '/'), 'http://127.0.0.1');
  const tz = url.searchParams.get('tz');
  const wantsPartial = url.searchParams.get('partial') === '1'
    // `x-rewind-partial` is the pre-rename header; still honoured so a cached
    // page from the older build keeps doing in-place swaps.
    || String(headers?.['x-unwrapped-partial'] ?? headers?.['x-rewind-partial'] ?? '') === '1';
  return {
    url,
    period: url.searchParams.get('period') || undefined,
    key: url.searchParams.get('key') || undefined,
    offsetMinutes: tz === null || tz === '' ? fallbackOffset : normalizeOffsetMinutes(tz, fallbackOffset),
    partial: wantsPartial,
  };
}

function launcherMarkup(path, label) {
  const style = [
    'position:fixed', 'right:18px', 'bottom:18px', 'z-index:40',
    'display:inline-flex', 'align-items:center', 'gap:7px',
    'padding:9px 14px', 'border-radius:999px',
    'background:linear-gradient(180deg,rgba(24,24,32,.96),rgba(12,12,18,.96))',
    'border:1px solid rgba(255,255,255,.14)',
    'color:#f4f4f6', 'font:600 12.5px/1 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif',
    'letter-spacing:.02em', 'text-decoration:none',
    'box-shadow:0 10px 28px rgba(0,0,0,.38)',
    'transition:transform .15s ease,border-color .15s ease',
  ].join(';');
  const dot = 'width:7px;height:7px;border-radius:50%;background:#ff2d55;box-shadow:0 0 10px rgba(255,45,85,.75)';
  return `<a id="dsh-unwrapped-launcher" href="${path}" target="_blank" rel="noopener" style="${style}" title="${label}">`
    + `<span style="${dot}"></span>${label}</a>`;
}

/** Insert the launcher before `</body>`; idempotent and safe on partial HTML. */
function injectLauncher(html, path, label) {
  if (typeof html !== 'string' || !html) return html;
  if (html.includes('id="dsh-unwrapped-launcher"')) return html;
  if (!html.includes('</body>')) return html;
  return html.replace('</body>', `${launcherMarkup(path, label)}</body>`);
}

/**
 * Register the plugin's routes. Returns a disposer that removes every route,
 * the index tap, and the launch link seam.
 */
function registerRewindRoutes(ctx, service, options) {
  const webServer = ctx.webServer;
  if (!webServer || typeof webServer.register !== 'function') {
    throw new Error('dsh-unwrapped needs ctx.webServer (mount the web profile)');
  }
  const disposers = [];
  const log = (message) => {
    try {
      ctx.logger?.('%s', message);
    } catch {
      /* ignore */
    }
  };

  disposers.push(webServer.register({
    kind: 'exact',
    path: options.apiPath,
    handler: async (req, res) => {
      const fallback = hostOffsetMinutes();
      const query = parseQuery(req.url, fallback);
      try {
        const report = await service.getReport(query);
        sendJson(res, 200, {
          period: report.range ?? report.period,
          generatedAt: report.generatedAt,
          report,
        });
      } catch (err) {
        log(`rewind: JSON request failed: ${err?.message ?? err}`);
        sendJson(res, 500, {
          error: 'rewind_failed',
          message: String(err?.message ?? err),
        });
      }
    },
  }));

  disposers.push(webServer.register({
    kind: 'exact',
    path: options.path,
    handler: async (req, res) => {
      const fallback = hostOffsetMinutes();
      const query = parseQuery(req.url, fallback, req.headers);
      const tz = query.offsetMinutes;
      const hrefFor = (kind, key) => {
        const params = new URLSearchParams({ period: kind, tz: String(tz) });
        if (key) params.set('key', key);
        return `${options.path}?${params.toString()}`;
      };
      try {
        const report = await service.getReport(query);
        sendHtml(res, 200, renderReport({
          report,
          lang: options.language,
          hrefFor,
          mode: query.partial ? 'fragment' : 'full',
        }));
      } catch (err) {
        log(`rewind: report request failed: ${err?.message ?? err}`);
        sendHtml(res, 500, `<!doctype html><meta charset="utf-8"><title>rewind</title>`
          + `<body style="background:#07070a;color:#f4f4f6;font:14px/1.7 -apple-system,Segoe UI,sans-serif;padding:48px">`
          + `<h1 style="font-size:20px">对话回顾生成失败</h1><p style="color:#8f8f9c">${String(err?.message ?? err).replace(/[<>&]/g, '')}</p>`
          + `</body>`);
      }
    },
  }));

  if (options.launcher !== false && typeof webServer.tapIndex === 'function') {
    disposers.push(webServer.tapIndex(
      (html) => injectLauncher(html, options.path, options.launcherLabel),
    ));
  }

  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose?.();
      } catch {
        /* a failed route disposal must not stop the remaining ones */
      }
    }
  };
}

export {
  registerRewindRoutes,
  injectLauncher,
  launcherMarkup,
  parseQuery,
  hostOffsetMinutes,
  buildReport,
};
