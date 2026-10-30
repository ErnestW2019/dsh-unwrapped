import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractSession } from '../lib/extract.js';
import { buildReport } from '../lib/aggregate.js';
import { renderReport, escapeHtml, formatCompact, formatDuration, SCRIPT } from '../lib/report.js';

const T0 = Date.UTC(2026, 5, 10, 22, 0, 0);

function fact(id, title, extra = {}) {
  return extractSession({
    header: { id, createdAt: T0, cwd: '/work/app', agentPreset: 'standard', ...extra },
    events: [
      { type: 'session/title', time: T0, data: { title } },
      { type: 'model/selection', time: T0, data: { provider: 'deepseek', model: 'deepseek-v4' } },
      { type: 'user/message', time: T0, data: { content: [{ type: 'text', text: 'hello there' }], source: { kind: 'user' } } },
      {
        type: 'assistant/message',
        time: T0 + 1000,
        data: { message: { content: [{ type: 'text', text: 'hi' }] }, usage: { inputTokens: 1000, outputTokens: 500 } },
      },
      { type: 'tool/call', time: T0 + 1500, data: { name: 'pwsh' } },
      { type: 'turn/start', time: T0, data: {} },
    ],
  });
}

function reportFor(facts = [fact('s1', 'Fix the build')], query = {}) {
  return buildReport(facts, { period: 'month', key: '2026-06', offsetMinutes: 0, nowMs: T0, ...query });
}

describe('report: escaping and formatting', () => {
  it('escapes HTML in untrusted session titles', () => {
    assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
    const html = renderReport({ report: reportFor([fact('s1', '<script>alert(1)</script>')]), lang: 'zh' });
    assert.equal(html.includes('<script>alert(1)</script>'), false);
    assert.equal(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), true);
  });

  it('formats compact numbers per language', () => {
    const zh = { lang: 'zh', units: { wan: '万', yi: '亿' } };
    const en = { lang: 'en', units: { wan: 'K', yi: 'M' } };
    assert.equal(formatCompact(999, zh), '999');
    assert.equal(formatCompact(12345, zh), '1.2万');
    assert.equal(formatCompact(123456789, zh), '1.2亿');
    assert.equal(formatCompact(12345, en), '12K');
    assert.equal(formatCompact(2500000, en), '2.5M');
  });

  it('formats durations', () => {
    assert.equal(formatDuration(1500), '1s');
    assert.equal(formatDuration(90_000), '1m');
    assert.equal(formatDuration(3 * 3600_000 + 24 * 60_000), '3h 24m');
  });
});

describe('report: rendering', () => {
  it('renders a populated report with the period label and key figures', () => {
    const report = reportFor();
    const html = renderReport({ report, lang: 'zh', hrefFor: (kind, key) => `?period=${kind}&key=${key ?? ''}` });
    assert.match(html, /2026 年 6 月/);
    assert.match(html, /对话回顾/);
    assert.match(html, /消息总数/);
    assert.match(html, /Fix the build/);
    assert.match(html, /href="\?period=month&amp;key=2026-05"/);
    assert.match(html, /<svg/);
    assert.equal(html.includes('undefined'), false);
  });

  it('renders the empty state when the period has no data', () => {
    const report = reportFor([], { key: '2021-01' });
    const html = renderReport({ report, lang: 'zh' });
    assert.match(html, /本期还没有数据/);
    assert.equal(html.includes('<svg'), false);
  });

  it('renders the english pack', () => {
    const html = renderReport({ report: reportFor(), lang: 'en' });
    assert.match(html, /Conversation Rewind/);
    assert.match(html, /Messages/);
    assert.equal(html.includes('消息总数'), false);
  });

  it('works without period navigation links (static file)', () => {
    const html = renderReport({ report: reportFor(), lang: 'zh', hrefFor: null });
    assert.match(html, /aria-disabled/);
    assert.equal(html.includes('href="?period'), false);
  });

  it('renders badges, failures, and highlight sessions when present', () => {
    const report = reportFor();
    const html = renderReport({ report, lang: 'zh' });
    assert.match(html, /本期称号/);
    assert.match(html, /高光对话/);
    assert.match(html, /本期高光对话/);
    assert.match(html, /和上一期相比/);
    assert.match(html, /deepseek-v4/);
  });
});

describe('report: interactivity surface', () => {
  it('ships a parseable client script and a JSON payload for the share card', () => {
    const html = renderReport({ report: reportFor(), lang: 'zh', hrefFor: (kind) => `?period=${kind}` });
    assert.match(html, /<script>/);
    assert.doesNotThrow(() => new Function(SCRIPT));
    const match = /<script type="application\/json" id="rw-meta">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(match, 'meta payload present');
    const meta = JSON.parse(match[1]);
    assert.equal(meta.human, 1);
    assert.equal(meta.ai, 1);
    assert.equal(meta.labels.title.length > 0, true);
    assert.equal(meta.ui.saved.length > 0, true);
  });

  it('escapes session text so a stray closing tag cannot break out', () => {
    const facts = [fact('s1', 'a </script><script>alert(1)</script> title')];
    const html = renderReport({ report: buildReport(facts, { period: 'month', key: '2026-06', offsetMinutes: 0, nowMs: T0 }), lang: 'zh' });
    assert.equal(html.includes('</script><script>alert(1)'), false);
    assert.equal(html.includes('&lt;/script&gt;&lt;script&gt;alert(1)'), true);
    const match = /id="rw-meta">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(match);
    assert.equal(typeof JSON.parse(match[1]).period, 'string');
  });

  it('renders a fragment that can be swapped into a live page', () => {
    const html = renderReport({ report: reportFor(), lang: 'zh', mode: 'fragment', hrefFor: (kind, key) => `?period=${kind}&key=${key ?? ''}` });
    assert.equal(html.includes('<!doctype html>'), false);
    assert.equal(html.includes('<script>'), false);
    assert.match(html, /^<div class="wrap" data-rewind-root data-period-key="2026-06">/);
    assert.match(html, /导航|2026 年 6 月/);
    assert.match(html, /data-count="/);
  });

  it('embeds alternate periods as inert templates for offline switching', () => {    const facts = [fact('s1', 'first')];
    const make = (key) => buildReport(facts, { period: 'month', key, offsetMinutes: 0, nowMs: T0 });
    const html = renderReport({
      report: make('2026-06'),
      lang: 'zh',
      hrefFor: (kind, key) => (key ? `#${key}` : null),
      alternates: [{ key: '2026-05', report: make('2026-05') }],
    });
    assert.match(html, /<template id="rw-body-2026-05" data-period-key="2026-05">/);
    assert.match(html, /href="#2026-05"/);
    // Inert markup: a template's contents are never matched by the live root.
    const live = /<div class="wrap" data-rewind-root data-period-key="2026-06">/.test(html);
    assert.equal(live, true);
  });

  it('exposes hover tooltips, count-up hooks, and an enhanced period link', () => {
    const html = renderReport({ report: reportFor(), lang: 'zh', hrefFor: (kind, key) => `?period=${kind}&key=${key ?? ''}` });
    assert.match(html, /data-tip="/);
    assert.match(html, /data-count="/);
    assert.match(html, /data-nav/);
    assert.match(html, /data-share/);
    assert.match(html, /data-theme-toggle/);
  });

  it('renders the emotional layer: quotes, latest night, phrases, closing line', () => {
    const facts = [extractSession({
      header: { id: 'q1', createdAt: T0, cwd: '/w' },
      events: [
        { type: 'user/message', time: T0, data: { content: [{ type: 'text', text: '为什么这个插件这么慢？' }], source: { kind: 'user' } } },
        { type: 'assistant/message', time: T0 + 1000, data: { message: { content: [{ type: 'text', text: 'let me look' }] } } },
        { type: 'user/message', time: T0 + 7200_000, data: { content: [{ type: 'text', text: '算了，明天再改' }], source: { kind: 'user' } } },
      ],
    })];
    const report = buildReport(facts, { period: 'month', key: '2026-06', offsetMinutes: 0, nowMs: T0 });
    const html = renderReport({ report, lang: 'zh' });
    assert.match(html, /你留下的句子/);
    assert.match(html, /最晚的一次/);
    assert.match(html, /第一次/);
    assert.match(html, /为什么这个插件这么慢？/);
    assert.match(html, /算了，明天再改/);
    assert.match(html, /它不会记得这些。日志会。/);
    assert.match(html, /class="closing-line"/);
    const meta = JSON.parse(/id="rw-meta">([\s\S]*?)<\/script>/.exec(html)[1]);
    assert.equal(typeof meta.closing, 'string');
    assert.equal(meta.closing.length > 8, true);
  });

  it('degrades gracefully when a period holds no quotes', () => {
    const report = buildReport([], { period: 'month', key: '2020-01', offsetMinutes: 0, nowMs: T0 });
    const html = renderReport({ report, lang: 'zh' });
    assert.match(html, /本期还没有数据/);
    assert.equal(html.includes('它不会记得这些'), false);
  });
});
