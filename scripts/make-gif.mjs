#!/usr/bin/env node
/**
 * Record a short scrolling clip of a report and encode it as a GIF.
 *
 *   node scripts/make-gif.mjs                       # -> docs/preview-year.gif
 *   node scripts/make-gif.mjs --file docs/preview-year.html --seconds 8
 *
 * Two steps, both needed:
 *   1. drive headless Edge over the DevTools protocol, screenshotting the page
 *      while scrolling, so the count-ups and the bar growth actually play;
 *   2. hand the frames to ffmpeg, which builds a palette before encoding —
 *      without that, a gradient-heavy dark page turns into a dithering mess.
 *
 * The page's own `prefers-reduced-motion` path is bypassed on purpose: the
 * motion is the point of this asset.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
const out = arg('out', 'docs/preview-year.gif');
const width = Number(arg('width', '880'));
const height = Number(arg('height', '600'));
const fps = Number(arg('fps', '8'));
const colors = Number(arg('colors', '64'));
const scrollPx = Number(arg('scroll', '1900')); // how far down the clip travels
const seconds = Number(arg('seconds', '5'));
const port = Number(arg('port', '9349'));

const target = pathToFileURL(file).href;
const edge = EDGE_CANDIDATES.find((path) => existsSync(path));
if (!edge) {
  console.error('no Edge/Chrome binary found');
  process.exit(2);
}

// ffmpeg ships with a lot of toolchains but is not a repo dependency.
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const probe = spawnSync(ffmpeg, ['-version'], { stdio: 'ignore' });
if (probe.status !== 0) {
  console.error(`ffmpeg not runnable (${ffmpeg}); install it or set FFMPEG=/path/to/ffmpeg`);
  process.exit(2);
}

const profile = mkdtempSync(join(tmpdir(), 'rewind-gif-'));
const frames = mkdtempSync(join(tmpdir(), 'rewind-frames-'));
const child = spawn(edge, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  '--force-prefers-reduced-motion=false',
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

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener('open', () => resolve(socket));
    socket.addEventListener('error', (event) => reject(new Error(`socket error: ${event.message ?? 'unknown'}`)));
  });
}

/** easeInOutCubic — a linear scroll reads like a broken video. */
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2);

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

  await page('Runtime.enable');
  await page('Page.enable');
  await page('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }],
  });
  await page('Page.navigate', { url: target });
  await sleep(1200);

  // Hold on the hero while the count-ups and the split bar play out, then
  // scroll with easing so the charts grow into view on camera.
  //
  // `[data-reveal]` starts at opacity 0 and only fades in when an
  // IntersectionObserver fires. A fast programmatic scroll can outrun that
  // observer and leave the viewport blank, so reveal is forced once up front:
  // the clip exists to show the motion, not the reveal-on-scroll behaviour.
  await evaluate(`(function(){
    var nodes = document.querySelectorAll('[data-reveal], .chart');
    for (var i = 0; i < nodes.length; i++) nodes[i].classList.add('in');
    // scroll-behavior:smooth would animate scrollTo; the loop needs the
    // scroll to land before the frame is captured.
    document.documentElement.style.scrollBehavior = 'auto';
  })()`);
  await sleep(700);
  await evaluate('window.scrollTo(0, 0)');
  await sleep(500);

  const frameCount = Math.round(fps * seconds);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const progress = frame / Math.max(1, frameCount - 1);
    const y = Math.round(scrollPx * ease(Math.min(1, progress * 1.15)));
    await evaluate(`window.scrollTo(0, ${y})`);
    await sleep(1000 / fps);
    // `clip` is in document coordinates, not viewport ones: without offsetting
    // y by scrollY the capture is the page's top-left corner, i.e. blank once
    // you have scrolled past the first screen.
    const scrollY = await evaluate('window.scrollY');
    const shot = await page('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      clip: { x: 0, y: scrollY, width, height, scale: 1 },
    });
    writeFileSync(join(frames, `f${String(frame).padStart(4, '0')}.png`), Buffer.from(shot.data, 'base64'));
  }
  const count = readdirSync(frames).filter((name) => name.endsWith('.png')).length;
  console.log(`captured ${count} frames`);

  // Two-pass palette keeps the dark gradients from banding. Fewer colours plus
  // `diff_mode` keep the file postable, which is the whole point of a README gif.
  const palette = join(frames, 'palette.png');
  const paletteRun = spawnSync(ffmpeg, [
    '-y', '-framerate', String(fps), '-i', join(frames, 'f%04d.png'),
    '-vf', `palettegen=max_colors=${colors}:stats_mode=diff`, palette,
  ], { encoding: 'utf8' });
  if (paletteRun.status !== 0) throw new Error(`palettegen failed: ${paletteRun.stderr.slice(-400)}`);

  const encode = spawnSync(ffmpeg, [
    '-y', '-framerate', String(fps), '-i', join(frames, 'f%04d.png'), '-i', palette,
    '-lavfi', `paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
    '-loop', '0', out,
  ], { encoding: 'utf8' });
  if (encode.status !== 0) throw new Error(`gif encode failed: ${encode.stderr.slice(-400)}`);

  console.log(`wrote ${out}`);
  browser.close();
} catch (err) {
  console.error(`make-gif failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  try { child.kill(); } catch {}
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  try { rmSync(frames, { recursive: true, force: true }); } catch {}
}
