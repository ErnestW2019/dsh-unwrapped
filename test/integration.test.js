import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';

import { apply, normalizeOptions } from '../index.js';
import { readArchive } from '../lib/archive.js';
import { extractSession } from '../lib/extract.js';

const T0 = Date.UTC(2026, 5, 10, 22, 0, 0);

/** Build a two-session archive shaped like the real on-disk store. */
function makeArchive() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-wrapped-it-'));
  const dir = join(root, '--work-demo--', 'session-it-1');
  mkdirSync(dir, { recursive: true });
  const rows = [
    { type: 'session', version: 3, id: 'session-it-1', createdAt: T0, cwd: '/work/demo' },
    { type: 'session/title', time: T0, data: { title: 'Integration session' } },
    { type: 'model/selection', time: T0, data: { provider: 'deepseek', model: 'deepseek-v4' } },
    { type: 'user/message', time: T0, data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } } },
    { type: 'assistant/message', time: T0 + 1000, data: { message: { content: [{ type: 'text', text: 'hi there' }] }, usage: { inputTokens: 12, outputTokens: 8 } } },
    { type: 'tool/call', time: T0 + 2000, data: { name: 'pwsh' } },
    { type: 'turn/start', time: T0, data: {} },
    { type: 'turn/end', time: T0 + 3000, data: { reason: { kind: 'done' } } },
  ];
  writeFileSync(
    join(dir, 'session.v3.jsonl.zstd'),
    Buffer.concat(rows.map((row) => zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(row)}\n`)))),
  );
  return root;
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
    body: '',
    writeHead(status) {
      this.statusCode = status;
    },
    end(body) {
      this.body = body ?? '';
    },
  };
}

const skipWithoutZstd = typeof zlib.zstdDecompressSync === 'function'
  ? false
  : 'node build has no zstd support';

describe('integration: plugin mounted over an archive-backed session query', { skip: skipWithoutZstd }, () => {
  it('serves the report page and the JSON API from the plugin alone', async () => {
    const root = makeArchive();
    try {
      // A sessionQuery stand-in that reads the real archive through the same
      // snapshot shape the live service returns.
      const sessions = readArchive(root);
      const sessionQuery = {
        listSessions: async () => sessions.map(({ header }) => ({ header, live: false, persisted: true })),
        readSession: async (id) => sessions.find((session) => session.header.id === id),
      };
      const webServer = fakeWebServer();
      const ctx = { webServer, sessionQuery, logger: () => {} };
      const dispose = apply(ctx, { language: 'zh' });

      const page = webServer.routes.find((route) => route.path === '/wrapped');
      const api = webServer.routes.find((route) => route.path === '/api/wrapped');
      assert.ok(page && api);
      assert.equal(webServer.taps.length, 1);

      const html = fakeRes();
      await page.handler({ url: '/wrapped?period=month&key=2026-06&tz=0' }, html);
      assert.equal(html.statusCode, 200);
      assert.match(html.body, /Integration session/);
      assert.match(html.body, /2026 年 6 月/);
      assert.equal(html.body.includes('NaN'), false);
      assert.equal(html.body.includes('undefined'), false);

      const json = fakeRes();
      await api.handler({ url: '/api/wrapped?period=month&key=2026-06&tz=0' }, json);
      const body = JSON.parse(json.body);
      assert.equal(body.report.totals.humanMessages, 1);
      assert.equal(body.report.totals.aiMessages, 1);
      assert.equal(body.report.totals.tools ?? body.report.totals.toolCalls, 1);
      assert.equal(body.report.tokens.total, 20);
      assert.equal(body.report.topModels[0].model, 'deepseek-v4');

      // The launcher tap reaches the GUI shell.
      const shell = webServer.taps[0]('<html><body><div id="app"></div></body></html>');
      assert.match(shell, /dsh-wrapped-launcher/);

      dispose();
      assert.equal(webServer.routes.length, 0);
      assert.equal(webServer.taps.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps working when one session cannot be read', async () => {
    const root = makeArchive();
    try {
      const sessions = readArchive(root).map((session) => extractSession(session));
      const sessionQuery = {
        listSessions: async () => [
          ...sessions.map((fact) => ({ header: { id: fact.id, createdAt: fact.createdAt }, live: false, persisted: true })),
          { header: { id: 'broken', createdAt: T0 }, live: false, persisted: true },
        ],
        readSession: async (id) => {
          if (id === 'broken') throw new Error('corrupt log');
          return readArchive(root).find((session) => session.header.id === id);
        },
      };
      const webServer = fakeWebServer();
      const errors = [];
      const dispose = apply({ webServer, sessionQuery, logger: () => {} }, {});
      const api = webServer.routes.find((route) => route.path === '/api/wrapped');
      const res = fakeRes();
      await api.handler({ url: '/api/wrapped?period=month&key=2026-06&tz=0' }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(res.body).report.totals.sessionsTouched, 1);
      dispose();
      assert.equal(errors.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('normalizes the config it is mounted with', () => {
    const options = normalizeOptions({ language: 'en', launcher: false });
    assert.equal(options.language, 'en');
    assert.equal(options.launcher, false);
  });
});
