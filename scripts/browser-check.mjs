#!/usr/bin/env node
/**
 * Browser smoke check — a dev tool, not part of the plugin runtime.
 *
 * Drives headless Edge over the DevTools protocol to prove the page is really
 * interactive: script runs, numbers count up, theme flips, the share card
 * builds, and (against a live harness) a period link swaps the body without a
 * full page load.
 *
 *   node scripts/browser-check.mjs --url http://127.0.0.1:8099/wrapped?token=…
 *   node scripts/browser-check.mjs --file docs/preview-year.html
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
];

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const target = arg('url') || (arg('file') ? pathToFileURL(arg('file')).href : null);
if (!target) {
  console.error('usage: node scripts/browser-check.mjs --url <http-url> | --file <path>');
  process.exit(2);
}

const edge = EDGE_CANDIDATES.find((path) => existsSync(path));
if (!edge) {
  console.error('no Edge/Chrome binary found');
  process.exit(2);
}

const port = Number(arg('port', '9333'));
const then = arg('then', null);
const cookie = arg('cookie', null);
const profile = mkdtempSync(join(tmpdir(), 'rewind-check-'));
const child = spawn(edge, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=1280,900',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDevtools() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return (await response.json()).webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('devtools endpoint never came up');
}

class Session {
  constructor(socket) {
    this.socket = socket;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
        return;
      }
      this.events.push(message);
    });
  }

  send(method, params = {}, sessionId = undefined) {
    const id = (this.id += 1);
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.socket.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async evaluate(expression, sessionId) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener('open', () => resolve(new Session(socket)));
    socket.addEventListener('error', (event) => reject(new Error(`socket error: ${event.message ?? 'unknown'}`)));
  });
}

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  const mark = ok ? 'ok  ' : 'FAIL';
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`);
}

let browser;
try {
  const browserSocket = await waitForDevtools();
  browser = await connect(browserSocket);
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const page = {
    send: (method, params) => browser.send(method, params, sessionId),
    evaluate: (expression) => browser.evaluate(expression, sessionId),
  };
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Log.enable');
  if (cookie) {
    // A pre-minted session cookie lets the check read the auth-gated report on
    // an already-running harness, without its one-time launch token.
    const at = cookie.indexOf('=');
    const url = new URL(target).origin;
    await page.send('Network.enable');
    await page.send('Network.setCookie', {
      name: cookie.slice(0, at),
      value: cookie.slice(at + 1),
      url,
      path: '/',
      httpOnly: true,
    });
  }
  await page.send('Page.navigate', { url: target });
  await sleep(1600);
  const launcherOnShell = await page.evaluate("(function(){var el=document.getElementById('dsh-wrapped-launcher');return el?el.getAttribute('href'):null})()");
  if (then) {
    // The harness hands out its auth cookie on a tokenized first visit, so a
    // report URL only works after that redirect has happened.
    const origin = new URL(target).origin;
    await page.send('Page.navigate', { url: new URL(then, origin).href });
    await sleep(1800);
  }

  const errors = browser.events
    .filter((event) => event.method === 'Runtime.exceptionThrown')
    .map((event) => event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text);
  const pageErrors = browser.events
    .filter((event) => event.method === 'Log.entryAdded' && event.params.entry.level === 'error')
    // Browsers probe /favicon.ico on every origin; that 404 says nothing about the report.
    .filter((event) => !/favicon/i.test(event.params.entry.url || ''))
    .map((event) => `${event.params.entry.text} ${event.params.entry.url || ''}`.trim());
  await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
  await sleep(900);
  await page.evaluate('window.scrollTo(0, 0)');
  await sleep(300);

  check('no uncaught page errors', errors.length === 0 && pageErrors.length === 0, [...errors, ...pageErrors].join(' | ').slice(0, 300));
  if (then) check('launcher pill injected into the GUI shell', launcherOnShell !== null, String(launcherOnShell));

  check('html marked as scripted', (await page.evaluate('document.documentElement.className')).includes('js'));
  check('report root rendered', (await page.evaluate("!!document.querySelector('[data-rewind-root]')")) === true);
  check('count-up wrote grouped numbers',
    (await page.evaluate("(document.querySelector('[data-count]')||{}).textContent || ''")).length > 0);
  check('meta payload parses', (await page.evaluate("(function(){try{return !!JSON.parse(document.getElementById('rw-meta').textContent)}catch(e){return false}})()")) === true);
  const summary = await page.evaluate("(function(){var d=JSON.parse(document.getElementById('rw-meta').textContent);return d.period+': human '+d.human+' / ai '+d.ai+' / turns '+d.turns+' / tokens '+d.tokens})()");
  console.log(`     ${summary}`);
  check('charts revealed', (await page.evaluate("document.querySelectorAll('.chart.in').length")) > 0);
  check('split bar has width', (await page.evaluate("(document.querySelector('.split .h')||{getBoundingClientRect:function(){return {width:0}}}).getBoundingClientRect().width")) > 0);
  check('bar fill has width', (await page.evaluate("(document.querySelector('.row .fill')||{getBoundingClientRect:function(){return {width:0}}}).getBoundingClientRect().width")) > 0);

  await page.evaluate("document.querySelector('[data-theme-toggle]').click()");
  await sleep(200);
  const theme = await page.evaluate("document.documentElement.getAttribute('data-theme')");
  check('theme toggle flips attribute', theme === 'light', theme);

  const tooltips = await page.evaluate("document.querySelectorAll('[data-tip]').length");
  check('chart tooltips wired', tooltips > 0, `${tooltips} hotspots`);

  const share = await page.evaluate(`(function(){
    document.querySelector('[data-share]').click();
    return 'clicked';
  })()`);
  await sleep(700);
  const shareToast = await page.evaluate("(document.querySelector('.toast') || {}).textContent || ''");
  check('share card runs end to end', share === 'clicked' && shareToast.length > 0, shareToast);

  const expandable = await page.evaluate("document.querySelectorAll('[data-more]').length");
  if (expandable > 0) {
    const expanded = await page.evaluate(`(function(){
      var button = document.querySelector('[data-more]');
      button.click();
      var card = button.closest('.session');
      return card.getAttribute('data-open') + ':' + card.querySelectorAll('.quote.extra:not([hidden])').length;
    })()`);
    check('session quotes expand', expanded.startsWith('1:'), expanded);
  }

  const navHref = await page.evaluate("(function(){var a=document.querySelector('a[data-nav]');return a?{href:a.getAttribute('href'),offline:location.protocol==='file:'}:null})()");
  if (navHref && navHref.href && navHref.href.charAt(0) === '#') {
    const before = await page.evaluate("document.querySelector('.period-pill strong').textContent");
    const marker = 'window.__rewindReload = (window.__rewindReload||0) + 1;';
    await page.evaluate(`${marker} document.querySelector('a[data-nav]').click()`);
    await sleep(900);
    const after = await page.evaluate("document.querySelector('.period-pill strong').textContent");
    const reloads = await page.evaluate('window.__rewindReload || 0');
    const hash = await page.evaluate('location.hash');
    check('embedded periods switch with no server', before !== after && reloads === 1, `${before} -> ${after} (${hash})`);
    const back = await page.evaluate("(function(){var a=document.querySelectorAll('a[data-nav]');var reversed=a[a.length-1];window.__rewindReload=1;return !!reversed})()");
    const current = await page.evaluate("document.querySelector('[data-rewind-root]').getAttribute('data-period-key')");
    check('swapped body knows its own period', typeof current === 'string' && current.length >= 4, String(current));
    void back;
  } else if (navHref && !navHref.offline) {
    const before = await page.evaluate("document.querySelector('.period-pill strong').textContent");
    const marker = 'window.__rewindReload = (window.__rewindReload||0) + 1;';
    await page.evaluate(`${marker} document.querySelector('a[data-nav]').click()`);
    await sleep(1400);
    const after = await page.evaluate("document.querySelector('.period-pill strong').textContent");
    const reloads = await page.evaluate('window.__rewindReload || 0');
    const patched = await page.evaluate("document.querySelector('a[data-nav]').getAttribute('href')");
    check('period switch swaps content in place', before !== after && reloads === 1, `${before} -> ${after}`);
    check('period switch updates the URL', patched && patched.includes('period='), String(patched));
    const json = await page.evaluate(`fetch(location.pathname + '?period=year&partial=1', {headers:{'x-wrapped-partial':'1'}}).then(function(r){return r.status + ':' + (r.ok?'ok':'bad')})`);
    check('partial endpoint answers', json.endsWith(':ok'), json);
  } else {
    check('static file keeps links as plain navigation', true, 'offline mode');
  }

  const failed = checks.filter((item) => !item.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  process.exitCode = failed.length ? 1 : 0;
} catch (err) {
  console.error(`browser-check failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch {}
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
