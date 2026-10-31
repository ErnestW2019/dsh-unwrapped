#!/usr/bin/env node
/**
 * Render the three share cards out of the offline preview and save them under
 * `docs/`. The cards are drawn on a canvas by the page's own share handler, so
 * the only honest way to get them is to let the page draw and download them.
 *
 *   node scripts/shot-cards.mjs
 *   node scripts/shot-cards.mjs --file docs/preview-year.html --out docs
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

const file = arg('file', 'docs/preview-year.html');
const outDir = arg('out', 'docs');
const kinds = (arg('kinds', 'main,contrast,phrase')).split(',').map((value) => value.trim()).filter(Boolean);
const target = pathToFileURL(file).href;

const edge = EDGE_CANDIDATES.find((path) => existsSync(path));
if (!edge) {
  console.error('no Edge/Chrome binary found');
  process.exit(2);
}

const port = Number(arg('port', '9347'));
const scale = Number(arg('scale', '0.5')); // 1080x1350 → 540x675 keeps the README light
const profile = mkdtempSync(join(tmpdir(), 'rewind-cards-'));
const downloads = mkdtempSync(join(tmpdir(), 'rewind-dl-'));
const child = spawn(edge, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--allow-file-access-from-files',
  '--window-size=1280,900',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDevtools() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return (await response.json()).webSocketDebuggerUrl;
    } catch {}
    await sleep(200);
  }
  throw new Error('devtools endpoint never came up');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener('open', () => resolve(socket));
    socket.addEventListener('error', (event) => reject(new Error(`socket error: ${event.message ?? 'unknown'}`)));
  });
}

/** Wait until a file whose name contains `kind` lands in the download dir. */
async function waitForDownload(kind, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = readdirSync(downloads).find((name) => name.includes(`-${kind}-`) && name.endsWith('.png'));
    if (hit) return hit;
    await sleep(120);
  }
  return null;
}

let browser;
try {
  browser = await connect(await waitForDevtools());
  let id = 0;
  const pending = new Map();
  browser.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const messageId = (id += 1);
    pending.set(messageId, { resolve, reject });
    browser.send(JSON.stringify({ id: messageId, method, params, sessionId }));
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = (method, params) => send(method, params, sessionId);
  const evaluate = async (expression) => {
    const result = await page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };

  await send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloads,
    eventsEnabled: true,
  });
  await page('Runtime.enable');
  await page('Page.enable');
  await page('Page.navigate', { url: target });
  await sleep(1600);
  // The reveal animations dim cards while they are off-screen; scroll once so
  // the page is fully painted before the canvas work starts.
  await evaluate('window.scrollTo(0, document.body.scrollHeight)');
  await sleep(600);
  await evaluate('window.scrollTo(0, 0)');
  await sleep(300);

  for (const kind of kinds) {
    const clicked = await evaluate(`(function(){
      var el = document.querySelector('[data-share="${kind}"]');
      if (!el) return false;
      el.click();
      return true;
    })()`);
    if (!clicked) {
      console.error(`skip ${kind}: no button on this page`);
      continue;
    }
    const name = await waitForDownload(kind);
    if (!name) throw new Error(`no download appeared for "${kind}"`);

    // The page always draws 1080x1350 (that is the share size people want), but
    // the README only shows 230px wide. Re-encode through a canvas so the
    // committed file stays small instead of shipping a 1.5 MB PNG per card.
    const source = readFileSync(join(downloads, name)).toString('base64');
    const scaled = await evaluate(`(function(){
      return new Promise(function(resolve, reject){
        var img = new Image();
        img.onload = function(){
          var c = document.createElement('canvas');
          c.width = Math.round(img.width * ${scale});
          c.height = Math.round(img.height * ${scale});
          var g = c.getContext('2d');
          g.imageSmoothingQuality = 'high';
          g.drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/png').split(',')[1]);
        };
        img.onerror = function(){ reject(new Error('decode failed')); };
        img.src = 'data:image/png;base64,${source}';
      });
    })()`);
    const out = join(outDir, `card-${kind}.png`);
    writeFileSync(out, Buffer.from(scaled, 'base64'));
    console.log(`wrote ${out}`);
  }
  browser.close();
} catch (err) {
  console.error(`shot-cards failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch {}
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  try { rmSync(downloads, { recursive: true, force: true }); } catch {}
}
