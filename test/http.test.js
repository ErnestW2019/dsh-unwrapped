import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { registerRewindRoutes, injectLauncher, parseQuery } from '../lib/http.js';
import { normalizeOptions } from '../index.js';
import { buildReport } from '../lib/aggregate.js';
import { extractSession } from '../lib/extract.js';

const T0 = Date.UTC(2026, 5, 10, 12, 0, 0);

function sampleFacts() {
  return [extractSession({
    header: { id: 's1', createdAt: T0, cwd: '/work/app' },
    events: [
      { type: 'user/message', time: T0, data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } },
      { type: 'assistant/message', time: T0 + 1000, data: { message: { content: [{ type: 'text', text: 'hello' }] }, usage: { inputTokens: 10, outputTokens: 5 } } },
      { type: 'turn/start', time: T0, data: {} },
    ],
  })];
}

function fakeWebServer() {
  const routes = [];
  const taps = [];
  return {
    routes,
    taps,
    register(route) {
      routes.push(route);
      return () => {
        const index = routes.indexOf(route);
        if (index >= 0) routes.splice(index, 1);
      };
    },
    tapIndex(fn) {
      taps.push(fn);
      return () => {
        const index = taps.indexOf(fn);
        if (index >= 0) taps.splice(index, 1);
      };
    },
  };
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers || {};
    },
    end(body) {
      this.body = body ?? '';
    },
  };
}

function setup(config = {}) {
  const webServer = fakeWebServer();
  const ctx = { webServer, logger: () => {} };
  const facts = sampleFacts();
  const service = {
    getReport: async (query = {}) => buildReport(facts, {
      period: query.period,
      key: query.key,
      offsetMinutes: query.offsetMinutes,
      nowMs: T0,
    }),
  };
  const options = normalizeOptions(config);
  const dispose = registerRewindRoutes(ctx, service, options);
  return { webServer, ctx, service, options, dispose };
}

describe('http: route registration', () => {
  it('registers the page and the JSON API on exact paths', () => {
    const { webServer } = setup();
    assert.deepEqual(webServer.routes.map((route) => route.path).sort(), ['/api/wrapped', '/wrapped']);
    assert.equal(webServer.routes.every((route) => route.kind === 'exact'), true);
  });

  it('honors custom paths and the launcher switch', () => {
    const { webServer } = setup({ path: '/insights/rewind', apiPath: '/insights/api', launcher: false });
    assert.deepEqual(webServer.routes.map((route) => route.path).sort(), ['/insights/api', '/insights/rewind']);
    assert.equal(webServer.taps.length, 0);
  });

  it('throws when the web server is missing', () => {
    assert.throws(
      () => registerRewindRoutes({}, { getReport: async () => ({}) }, normalizeOptions({})),
      /ctx\.webServer/,
    );
  });

  it('disposes every route and the index tap', () => {
    const { webServer, dispose } = setup();
    assert.equal(webServer.routes.length, 2);
    assert.equal(webServer.taps.length, 1);
    dispose();
    assert.equal(webServer.routes.length, 0);
    assert.equal(webServer.taps.length, 0);
  });
});

describe('http: handlers', () => {
  it('serves the HTML report with navigable period links', async () => {
    const { webServer } = setup();
    const route = webServer.routes.find((item) => item.path === '/wrapped');
    const res = fakeRes();
    await route.handler({ url: '/wrapped?period=month&key=2026-06&tz=0' }, res);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.body, /2026 年 6 月/);
    assert.match(res.body, /href="\/wrapped\?period=month&amp;tz=0&amp;key=2026-05"/);
  });

  it('serves the JSON API', async () => {
    const { webServer } = setup();
    const route = webServer.routes.find((item) => item.path === '/api/wrapped');
    const res = fakeRes();
    await route.handler({ url: '/api/wrapped?period=quarter&key=2026-Q2&tz=480' }, res);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /application\/json/);
    const body = JSON.parse(res.body);
    assert.equal(body.period.quarter, 2);
    assert.equal(body.report.totals.humanMessages, 1);
    assert.equal(body.report.totals.aiMessages, 1);
  });

  it('returns 500 JSON when aggregation throws', async () => {
    const webServer = fakeWebServer();
    const ctx = { webServer, logger: () => {} };
    registerRewindRoutes(ctx, { getReport: async () => { throw new Error('boom'); } }, normalizeOptions({}));
    const route = webServer.routes.find((item) => item.path === '/api/wrapped');
    const res = fakeRes();
    await route.handler({ url: '/api/wrapped' }, res);
    assert.equal(res.statusCode, 500);
    assert.equal(JSON.parse(res.body).error, 'rewind_failed');
  });

  it('parses period, key, and offset with a fallback', () => {
    const parsed = parseQuery('/wrapped?period=year&key=2026&tz=-300', 480);
    assert.equal(parsed.period, 'year');
    assert.equal(parsed.key, '2026');
    assert.equal(parsed.offsetMinutes, -300);
    assert.equal(parsed.partial, false);
    assert.equal(parseQuery('/wrapped?partial=1', 480).partial, true);
    assert.equal(parseQuery('/wrapped', 480, { 'x-wrapped-partial': '1' }).partial, true);
    assert.equal(parseQuery('/wrapped', 480).offsetMinutes, 480);
    assert.equal(parseQuery('/wrapped?tz=99999', 480).offsetMinutes, 480);
  });

  it('serves a fragment for partial requests', async () => {
    const { webServer } = setup();
    const route = webServer.routes.find((item) => item.path === '/wrapped');
    const res = fakeRes();
    await route.handler({ url: '/wrapped?period=month&key=2026-06&tz=0&partial=1', headers: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.includes('<!doctype html>'), false);
    assert.match(res.body, /data-rewind-root/);
    assert.match(res.body, /2026 年 6 月/);
  });
});

describe('http: launcher injection', () => {
  it('adds one launcher link before </body>', () => {
    const html = injectLauncher('<html><body><div id="app"></div></body></html>', '/wrapped', '年度回顾');
    assert.match(html, /dsh-wrapped-launcher/);
    assert.match(html, /href="\/wrapped"/);
    assert.match(html, /年度回顾/);
    assert.equal(html.indexOf('dsh-wrapped-launcher') < html.indexOf('</body>'), true);
  });

  it('is idempotent and safe on markup without a body', () => {
    const once = injectLauncher('<body></body>', '/wrapped', '年度回顾');
    assert.equal(injectLauncher(once, '/wrapped', '年度回顾'), once);
    assert.equal(injectLauncher('<div></div>', '/wrapped', 'X'), '<div></div>');
    assert.equal(injectLauncher(null, '/wrapped', 'X'), null);
  });

  it('wires the tap to the configured path and label', () => {
    const { webServer } = setup({ path: '/r', launcherLabel: 'Rewind' });
    const html = webServer.taps[0]('<body></body>');
    assert.match(html, /href="\/r"/);
    assert.match(html, /Rewind/);
  });
});

describe('config: normalizeOptions', () => {
  it('applies defaults', () => {
    const options = normalizeOptions();
    assert.equal(options.path, '/wrapped');
    assert.equal(options.apiPath, '/api/wrapped');
    assert.equal(options.language, 'zh');
    assert.equal(options.launcher, true);
    assert.equal(options.cacheTtlMs, 60_000);
    assert.equal(options.maxSessions, 800);
  });

  it('accepts overrides', () => {
    const options = normalizeOptions({
      path: '/insights/',
      apiPath: '/insights/api',
      language: 'en-US',
      launcher: false,
      maxSessions: 50,
      cacheTtlMs: 0,
    });
    assert.equal(options.path, '/insights');
    assert.equal(options.language, 'en');
    assert.equal(options.launcher, false);
    assert.equal(options.maxSessions, 50);
    assert.equal(options.cacheTtlMs, 0);
  });

  it('rejects bad paths and collisions', () => {
    assert.throws(() => normalizeOptions({ path: 'rewind' }), /must start with/);
    assert.throws(() => normalizeOptions({ apiPath: '/wrapped', path: '/wrapped' }), /must differ/);
  });

  it('clamps numeric knobs instead of trusting them', () => {
    const options = normalizeOptions({ maxSessions: 'abc', concurrency: 999, cacheTtlMs: -5 });
    assert.equal(options.maxSessions, 800);
    assert.equal(options.concurrency, 16);
    assert.equal(options.cacheTtlMs, 60_000);
  });
});
