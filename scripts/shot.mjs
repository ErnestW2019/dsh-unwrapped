#!/usr/bin/env node
/**
 * Full-page screenshot of a report, via the DevTools protocol.
 *
 *   node scripts/shot.mjs --file docs/preview-year.html --out docs/preview-year.png
 *
 * `--screenshot` alone only rasterizes the viewport, and a very tall window
 * silently leaves everything past the first screen blank — which also freezes
 * the scroll-reveal animations at opacity 0. So this drives the real page:
 * scroll through it to fire every IntersectionObserver, then capture beyond the
 * viewport at the measured content size.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const out = arg('out', 'docs/preview.png');
const width = Number(arg('width', '1180'));
const height = Number(arg('height', '900'));
if (!target) {
  console.error('usage: node scripts/shot.mjs --file <path> --out <png>');
  process.exit(2);
}

const edge = EDGE_CANDIDATES.find((path) => existsSync(path));
if (!edge) {
  console.error('no Edge/Chrome binary found');
  process.exit(2);
}

const port = Number(arg('port', '9345'));
const profile = mkdtempSync(join(tmpdir(), 'rewind-shot-'));
const child = spawn(edge, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--hide-scrollbars',
  `--window-size=${width},${height}`,
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

try {
  const socket = new WebSocket(await waitForDevtools());
  await new Promise((resolve) => socket.addEventListener('open', resolve));
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
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
    socket.send(JSON.stringify({ id: messageId, method, params, sessionId }));
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = (method, params) => send(method, params, sessionId);
  const evaluate = async (expression) => {
    const result = await page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };

  await page('Runtime.enable');
  await page('Page.enable');
  await page('Page.navigate', { url: target });
  await sleep(1200);

  // Walk the page so every reveal fires, then settle back at the top.
  const total = await evaluate('document.documentElement.scrollHeight');
  for (let y = 0; y < total; y += Math.round(height * 0.7)) {
    await evaluate(`window.scrollTo(0, ${y})`);
    await sleep(160);
  }
  await evaluate('window.scrollTo(0, document.documentElement.scrollHeight)');
  await sleep(900);
  await evaluate('window.scrollTo(0, 0)');
  await sleep(400);

  const metrics = await page('Page.getLayoutMetrics');
  const contentHeight = Math.ceil((metrics.cssContentSize || metrics.contentSize).height);
  const shot = await page('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width, height: contentHeight, scale: 1 },
  });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`wrote ${out} (${width}x${contentHeight})`);
  socket.close();
} catch (err) {
  console.error(`shot failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch {}
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
