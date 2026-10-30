#!/usr/bin/env node
/**
 * Build a synthetic session archive and render the committed previews from it.
 *
 *   node scripts/make-demo.mjs                       # -> .demo/sessions + docs/preview-*.html
 *   node scripts/make-demo.mjs --out .demo/sessions --keep-archive
 *
 * Why this exists: the hero screenshot in the README is generated from real
 * session logs, and real logs contain real things people typed. A public repo
 * must not ship someone's chat. So everything under `docs/` is rendered from
 * this deterministic, obviously-fictional dataset instead — same shapes, same
 * pipeline, zero private text.
 *
 * The generator writes each log as TWO zstd frames on purpose: that is how the
 * harness appends, and it keeps the multi-frame reader on the demo path too.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import zlib from 'node:zlib';

const DEFAULT_OUT = '.demo/sessions';
const TZ = 480; // +08:00, the hour distribution reads like a normal working week

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const outRoot = arg('out', DEFAULT_OUT);
const keepArchive = process.argv.includes('--keep-archive');

/** Deterministic PRNG so regenerating the demo yields byte-identical input. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(20261030);
const pick = (list) => list[Math.floor(random() * list.length)];
const between = (min, max) => min + Math.floor(random() * (max - min + 1));

const WORKSPACES = [
  { slug: 'home-code-aurora-ui', cwd: '/home/dev/code/aurora-ui' },
  { slug: 'home-code-pipeline', cwd: '/home/dev/code/pipeline' },
  { slug: 'home-code-tiny-db', cwd: '/home/dev/code/tiny-db' },
  { slug: 'work-notes', cwd: '/home/dev/work/notes' },
];

const TITLES = [
  '重构表格排序逻辑',
  '修一个只在 CI 挂的测试',
  '给设置页加暗色主题',
  '调研向量检索方案',
  '把构建时间从 90s 压到 20s',
  '给上传接口加并发限制',
  '排查内存泄漏',
  '写一份发布检查清单',
  '把报告页改成可分享的图片',
  '统一各处的错误码',
  '给 CLI 加一个 --dry-run',
  '补一组边界条件测试',
  '把日志里的时间戳统一成 UTC',
  '梳理一下这个模块的依赖',
  '给搜索加上拼音匹配',
  '优化首屏加载',
  '把配置从 JSON 换成 YAML',
  '给接口加缓存',
];

const HUMAN_LINES = [
  '这个报错你能看出是哪一步吗',
  '能不能拆成两个函数',
  '再加个测试吧',
  '算了，先回滚这一版',
  '谢谢，跑通了',
  '为什么这里会慢',
  '帮我看看这个类型为什么不匹配',
  '这个方案和上次那个有什么区别',
  '先别改，我确认一下需求',
  '再试一次，还是不行',
  '文档里这段是什么意思',
  '能不能只改这一处，别动别的',
  '这个颜色太亮了，换暗一点',
  '把这段抽成插件',
  '有没有更简单的写法',
  '我刚才那个改动是不是把缓存弄坏了',
  '线上现在能用吗',
  '这里为什么会重复请求',
  '先写测试再改',
  '这个接口的返回结构不太对',
  '我这边看不到日志',
  '换个思路试试',
  '确认一下，这样可以吗',
  '等等，这个文件是谁改的',
];

const AI_LINES = [
  '看了下日志，是缓存键没带上租户前缀，我改成 `tenantId:userId` 了。',
  '拆好了：`parseRows` 只做解析，`sortRows` 只做排序，各自一个测试。',
  '加了一个覆盖空数组和单元素的用例，跑过之后 CI 就绿了。',
  '回滚了这一版，重新加了个开关，默认关。',
  '慢在每行都重新算一次长度，提到循环外面之后从 1.8s 降到 0.2s。',
  '类型不匹配是因为 `readonly` 数组不能直接 push，复制一份再改就行。',
  '那个方案要改数据表结构，这个只动读取路径，风险小很多。',
  '好，先不动，等你确认。',
  '第二次还是同样的错，说明不是偶发，我把中间值打出来看看。',
  '这段是「没有命中缓存时的兜底」，注释里写了原因。',
  '只改了颜色变量，其他样式没动。',
  '抽成插件了，入口 `index.js`，配置走 patch 文件。',
  '可以更简单，用 `Object.groupBy` 一行就够了。',
  '是的，缓存键冲突了，现在换成了带版本号的前缀。',
  '线上能用，但要重启一次进程才会读到新代码。',
  '重复请求是因为两个 effect 依赖了同一份状态，合并成一个就好。',
  '先加了一个会失败的测试，再改实现让它通过。',
  '返回结构改成 `{ items, total }`，调用方我一起改掉了。',
  '日志被写到临时目录了，`--verbose` 会打到 stderr。',
  '换了个思路：不动数据，只加一层投影。',
];

const TOOLS = ['pwsh', 'read', 'edit', 'grep', 'glob', 'write', 'subagent', 'web_fetch'];
const MODELS = [
  { provider: 'deepseek', model: 'deepseek-chat' },
  { provider: 'deepseek', model: 'deepseek-reasoner' },
  { provider: 'internal', model: 'code-fast' },
];
const PRESETS = ['standard', 'standard', 'standard', 'reviewer'];

/** Local wall clock at +08:00 → epoch ms. */
function localMs(year, month, day, hour, minute) {
  return Date.UTC(year, month - 1, day, hour, minute) - TZ * 60_000;
}

function makeSession(index, start, workspace, title) {
  const id = `demo-${String(index).padStart(3, '0')}`;
  const model = pick(MODELS);
  const rows = [
    {
      type: 'session',
      id,
      createdAt: start,
      cwd: workspace.cwd,
      agentPreset: pick(PRESETS),
    },
    { type: 'session/title', time: start + 1_000, data: { title } },
    { type: 'model/selection', time: start + 1_500, data: model },
  ];

  const turns = between(1, 6);
  let cursor = start;
  for (let turn = 0; turn < turns; turn += 1) {
    cursor += between(20, 400) * 1_000;
    const human = pick(HUMAN_LINES);
    const ai = pick(AI_LINES);
    const aiChars = ai.length;
    rows.push({ type: 'turn/start', time: cursor, data: {} });
    rows.push({
      type: 'user/message',
      time: cursor,
      data: { content: [{ type: 'text', text: human }], source: { kind: 'user' } },
    });
    cursor += between(4, 90) * 1_000;
    rows.push({
      type: 'assistant/message',
      time: cursor,
      data: {
        message: { content: [{ type: 'text', text: ai }] },
        usage: {
          inputTokens: between(2_000, 26_000),
          outputTokens: Math.round(aiChars * between(2, 5)),
          cacheReadTokens: between(0, 8_000),
        },
      },
    });
    const toolCalls = between(0, 3);
    for (let call = 0; call < toolCalls; call += 1) {
      cursor += between(2, 40) * 1_000;
      rows.push({ type: 'tool/call', time: cursor, data: { name: pick(TOOLS) } });
    }
    cursor += between(1, 20) * 1_000;
    rows.push({ type: 'turn/end', time: cursor, data: {} });
    rows.push({ type: 'step/end', time: cursor, data: {} });
  }
  return { id, rows };
}

/**
 * Two frames, exactly like an interrupted-then-resumed writer would leave.
 * The reader has to walk both; a single-frame demo would never prove that.
 */
function writeLog(dir, rows) {
  mkdirSync(dir, { recursive: true });
  const lines = rows.map((row) => JSON.stringify(row));
  const half = Math.ceil(lines.length / 2);
  const parts = [lines.slice(0, half), lines.slice(half)]
    .filter((part) => part.length)
    .map((part) => zlib.zstdCompressSync(Buffer.from(`${part.join('\n')}\n`, 'utf8')));
  writeFileSync(join(dir, 'session.v3.jsonl.zstd'), Buffer.concat(parts));
}

function buildArchive(root) {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  let index = 0;
  let sessions = 0;
  // Three calendar years so a yearly report, its delta, and the embedded
  // alternates all have something real to show.
  for (const year of [2024, 2025, 2026]) {
    const months = year === 2026 ? 10 : 12;
    for (let month = 1; month <= months; month += 1) {
      const sessionsThisMonth = between(1, 3);
      for (let s = 0; s < sessionsThisMonth; s += 1) {
        const day = between(1, 27);
        // Mostly office hours, with the occasional late night so the
        // 「最晚的一次」 card has something to point at.
        const late = random() < 0.18;
        const hour = late ? between(21, 23) : between(9, 19);
        const minute = between(0, 59);
        const workspace = pick(WORKSPACES);
        const { id, rows } = makeSession(index, localMs(year, month, day, hour, minute), workspace, pick(TITLES));
        writeLog(join(root, workspace.slug, id), rows);
        index += 1;
        sessions += 1;
      }
    }
  }
  return sessions;
}

function run(args) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`command failed: node ${args.join(' ')}`);
}

const sessions = buildArchive(outRoot);
console.log(`wrote ${sessions} synthetic sessions to ${outRoot} (timezone +08:00)`);

const common = ['--archive', outRoot, '--tz', String(TZ)];
run(['bin/wrapped.js', ...common, '--period', 'year', '--key', '2026', '--embed', '13', '--out', 'docs/preview-year.html', '--json', 'docs/preview-year.json']);
run(['bin/wrapped.js', ...common, '--period', 'quarter', '--key', '2026-Q3', '--embed', '8', '--out', 'docs/preview-quarter.html']);
run(['bin/wrapped.js', ...common, '--period', 'month', '--key', '2020-01', '--embed', '12', '--out', 'docs/preview-empty.html']);

if (!keepArchive) rmSync(outRoot, { recursive: true, force: true });
console.log('\npreviews rebuilt from synthetic data. next: node scripts/shot.mjs --file docs/preview-year.html --out docs/preview-year.png');
