import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractSession } from '../lib/extract.js';
import { buildReport, share, deltaPct, maxStreak, rankPhrases } from '../lib/aggregate.js';
import { resolvePeriod } from '../lib/periods.js';

const JUNE = Date.UTC(2026, 5, 10, 22, 0, 0); // 2026-06-10T22:00Z, local 22:00 at +0
const JUNE_EVENING = Date.UTC(2026, 5, 11, 23, 30, 0);
const MAY = Date.UTC(2026, 4, 20, 9, 0, 0);

function fact(id, events, header = {}) {
  return extractSession({
    header: { id, createdAt: header.createdAt ?? JUNE, cwd: header.cwd ?? '/work/app', agentPreset: 'standard', ...header },
    events,
  });
}

function human(t, text = 'hello') {
  return { type: 'user/message', time: t, data: { content: [{ type: 'text', text }], source: { kind: 'user' } } };
}

function ai(t, text = 'hi there', usage = { inputTokens: 10, outputTokens: 20 }) {
  return { type: 'assistant/message', time: t, data: { message: { content: [{ type: 'text', text }] }, usage } };
}

function sampleFacts() {
  return [
    fact('s1', [
      { type: 'session/title', time: JUNE, data: { title: 'Refactor the parser' } },
      { type: 'model/selection', time: JUNE, data: { provider: 'deepseek', model: 'deepseek-v4' } },
      human(JUNE, 'please refactor'),
      ai(JUNE + 1000, 'sure, done'),
      human(JUNE_EVENING, 'and now tests'),
      ai(JUNE_EVENING + 1000, 'tests added'),
      { type: 'tool/call', time: JUNE_EVENING + 1500, data: { name: 'pwsh' } },
      { type: 'turn/start', time: JUNE, data: {} },
      { type: 'turn/start', time: JUNE_EVENING, data: {} },
    ]),
    fact('s2', [
      { type: 'model/selection', time: JUNE, data: { provider: 'token-hub', model: 'deepseek-v4-1-flash' } },
      human(JUNE, 'short'),
      ai(JUNE + 500, 'ok'),
    ], { cwd: '/work/other', delegationDepth: 1, origin: 'subagent' }),
    fact('s3-old', [
      human(MAY, 'may message'),
      ai(MAY + 500, 'may answer'),
    ], { createdAt: MAY }),
  ];
}

describe('aggregate: totals and ratios', () => {
  it('aggregates a month with human/AI split, tokens, and sessions', () => {
    const report = buildReport(sampleFacts(), { period: 'month', key: '2026-06', offsetMinutes: 0, nowMs: JUNE });
    assert.equal(report.hasData, true);
    assert.equal(report.totals.humanMessages, 3);
    assert.equal(report.totals.aiMessages, 3);
    assert.equal(report.totals.messages, 6);
    assert.equal(report.totals.turns, 2);
    assert.equal(report.totals.toolCalls, 1);
    assert.equal(report.totals.sessionsTouched, 2);
    assert.equal(report.totals.delegatedSessions, 1);
    assert.equal(report.totals.activeDays, 2);
    assert.equal(report.totals.maxStreak, 2);
    assert.equal(report.tokens.total, 90); // 3 AI messages × 30
    assert.equal(report.ratio.humanShare, 0.5);
    assert.equal(report.ratio.aiShare, 0.5);
    assert.equal(report.ratio.humanToAi, 1);
    assert.equal(report.totals.peakHour, 22);
    assert.equal(report.topSessions[0].id, 's1');
    assert.equal(report.topSessions[0].title, 'Refactor the parser');
    assert.equal(report.topSessions[0].messages, 4);
    assert.equal(report.totals.busiestDay.day, '2026-06-10');
  });

  it('excludes activity from other periods', () => {
    const report = buildReport(sampleFacts(), { period: 'month', key: '2026-05', offsetMinutes: 0, nowMs: JUNE });
    assert.equal(report.totals.humanMessages, 1);
    assert.equal(report.totals.aiMessages, 1);
    assert.equal(report.totals.sessionsTouched, 1);
    assert.equal(report.topSessions[0].id, 's3-old');
  });

  it('exposes the previous-period comparison', () => {
    const report = buildReport(sampleFacts(), { period: 'month', key: '2026-06', offsetMinutes: 0, nowMs: JUNE });
    assert.equal(report.comparison.prevKey, '2026-05');
    assert.equal(report.comparison.human, 1);
    assert.equal(report.comparison.ai, 1);
    assert.equal(report.comparison.deltas.messagesPct, 200); // 6 vs 2
  });

  it('returns a valid empty report when nothing happened', () => {
    const report = buildReport(sampleFacts(), { period: 'quarter', key: '2020-Q1', offsetMinutes: 0, nowMs: JUNE });
    assert.equal(report.hasData, false);
    assert.equal(report.totals.messages, 0);
    assert.equal(report.series.length, 13);
    assert.equal(report.series.every((bucket) => bucket.total === 0), true);
    assert.equal(report.badges.length, 0);
    assert.equal(report.topSessions.length, 0);
  });
});

describe('aggregate: series and distributions', () => {
  it('buckets series by day for a month and by month for a year', () => {
    const facts = sampleFacts();
    const month = buildReport(facts, { period: 'month', key: '2026-06', offsetMinutes: 0, nowMs: JUNE });
    assert.equal(month.series.length, 30);
    assert.equal(month.series.filter((b) => b.total > 0).length, 2);
    const year = buildReport(facts, { period: 'year', key: '2026', offsetMinutes: 0, nowMs: JUNE });
    assert.equal(year.series.length, 12);
    assert.equal(year.series[4].total, 2); // May
    assert.equal(year.series[5].total, 6); // June
  });

  it('counts models and tools per message inside the window', () => {
    const report = buildReport(sampleFacts(), { period: 'month', key: '2026-06', offsetMinutes: 0, nowMs: JUNE });
    const models = Object.fromEntries(report.topModels.map((entry) => [entry.model, entry.count]));
    assert.equal(models['deepseek-v4'], 2);
    assert.equal(models['deepseek-v4-1-flash'], 1);
    assert.deepEqual(report.tools, [{ name: 'pwsh', count: 1 }]);
    assert.equal(report.topProviders.length, 2);
  });

  it('resolves local hours through the timezone offset', () => {
    // 2026-06-10T22:00Z is 06:00 the next day at +480; 23:30Z is 07:30.
    const report = buildReport(sampleFacts(), { period: 'month', key: '2026-06', offsetMinutes: 480, nowMs: JUNE });
    assert.equal(report.totals.peakHour, 6);
    assert.equal(report.hours[6], 4);
    assert.equal(report.hours[7], 2);
  });
});

describe('aggregate: badges', () => {
  it('awards a night-owl badge for late-night peaks', () => {
    const report = buildReport(sampleFacts(), { period: 'month', key: '2026-06', offsetMinutes: 0, nowMs: JUNE });
    assert.equal(report.badges[0].key, 'night_owl');
    assert.equal(report.badges[0].metric, 22);
  });

  it('returns no badges for a tiny period', () => {
    const facts = [fact('tiny', [human(JUNE, 'hi'), ai(JUNE + 1)])];
    const report = buildReport(facts, { period: 'month', key: '2026-06', offsetMinutes: 0, nowMs: JUNE });
    assert.deepEqual(report.badges, []);
  });
});

describe('aggregate: moments (the emotional layer)', () => {
  const LATE = Date.UTC(2026, 5, 12, 3, 40, 0); // 03:40 local at +0

  function momentsFacts() {
    return [
      fact('m1', [
        { type: 'session/title', time: JUNE, data: { title: 'Refactor the parser' } },
        human(JUNE, '为什么这个插件这么慢？'),
        ai(JUNE + 1000, 'let me look'),
        human(LATE, '算了，明天再改'),
        ai(LATE + 1000, 'ok'),
        human(Date.UTC(2026, 5, 12, 19, 5), '好的'),
      ]),
      fact('m2', [
        human(Date.UTC(2026, 4, 2, 10, 0), '五月的第一句'),
        ai(Date.UTC(2026, 4, 2, 10, 1), 'hi'),
        human(Date.UTC(2026, 4, 2, 10, 2), '谢谢，再来一次？'),
      ], { createdAt: Date.UTC(2026, 4, 2, 10, 0) }),
    ];
  }

  it('picks first/last lines and the latest night of the period only', () => {
    const report = buildReport(momentsFacts(), { period: 'month', key: '2026-06', offsetMinutes: 0, nowMs: JUNE });
    assert.equal(report.moments.first.text, '为什么这个插件这么慢？');
    assert.equal(report.moments.last.text, '好的');
    assert.equal(report.moments.latestNight.hour, 3);
    assert.equal(report.moments.latestNight.minute, 40);
    // 19:05 is not "late night" — the window starts at 21:00.
    assert.notEqual(report.moments.latestNight.text, '好的');
  });

  it('counts questions and thanks per message, windowed by period', () => {
    const june = buildReport(momentsFacts(), { period: 'month', key: '2026-06', offsetMinutes: 0, nowMs: JUNE });
    const may = buildReport(momentsFacts(), { period: 'month', key: '2026-05', offsetMinutes: 0, nowMs: JUNE });
    assert.equal(june.moments.questions, 1);
    assert.equal(june.moments.thanks, 0);
    assert.equal(may.moments.questions, 1);
    assert.equal(may.moments.thanks, 1);
  });

  it('keeps a timeline of the first line per bucket', () => {
    const report = buildReport(momentsFacts(), { period: 'quarter', key: '2026-Q2', offsetMinutes: 0, nowMs: JUNE });
    // Quarter series buckets are weeks, keyed by their first day.
    assert.equal(report.moments.timeline.length, 2);
    assert.equal(report.moments.timeline[0].text, '五月的第一句');
    assert.equal(report.moments.timeline[1].text, '为什么这个插件这么慢？');
  });

  it('reports the longest sitting with its session title', () => {
    const report = buildReport(momentsFacts(), { period: 'month', key: '2026-06', offsetMinutes: 0, nowMs: JUNE });
    assert.equal(report.moments.longest.title, 'Refactor the parser');
    assert.equal(report.moments.longest.runMs > 0, true);
  });

  it('ranks repeated words and drops the contained shorter form', () => {
    const ranked = rankPhrases({ 再试试: 3, 再试: 3, 插件: 9, 随便: 1 }, 3);
    const words = ranked.map((entry) => entry.word);
    assert.equal(words[0], '插件');
    assert.equal(words.includes('再试试'), true);
    assert.equal(words.includes('再试'), false);
    assert.equal(words.includes('随便'), false, 'below the min count');

    const facts = [fact('p1', [
      human(JUNE, '再试试这个插件'),
      human(JUNE + 10, '这个插件还是不行，再试试'),
      ai(JUNE + 20, 'ok'),
    ])];
    const report = buildReport(facts, { period: 'month', key: '2026-06', offsetMinutes: 0, nowMs: JUNE });
    // All three are said twice, so their order carries no meaning — what
    // matters is that it is the same on every host. Collation must not leak in
    // here: the same corpus once ranked differently under a C locale.
    assert.deepEqual(report.phrases.map((entry) => entry.word), ['再试', '插件', '试试']);
    assert.equal(report.phrases[0].count, 2);
    const again = buildReport(facts, { period: 'month', key: '2026-06', offsetMinutes: 0, nowMs: JUNE });
    assert.deepEqual(again.phrases, report.phrases);
  });

  it('has empty moments for a period with no data', () => {
    const report = buildReport([], { period: 'month', key: '2020-01', offsetMinutes: 0, nowMs: JUNE });
    assert.equal(report.moments.first, null);
    assert.deepEqual(report.moments.timeline, []);
    assert.deepEqual(report.phrases, []);
    assert.equal(report.moments.questions, 0);
  });
});

describe('aggregate: helpers', () => {
  it('computes shares and deltas safely', () => {
    assert.equal(share(1, 4), 0.25);
    assert.equal(share(1, 0), 0);
    assert.equal(deltaPct(10, 0), null);
    assert.equal(deltaPct(10, 5), 100);
    assert.equal(deltaPct(5, 10), -50);
  });

  it('computes the longest consecutive-day streak', () => {
    assert.equal(maxStreak([1, 2, 3, 7]), 3);
    assert.equal(maxStreak([5, 1, 2, 3, 4]), 5);
    assert.equal(maxStreak([1, 2, 3, 10]), 3);
    assert.equal(maxStreak([]), 0);
  });

  it('carries the resolved period through the report', () => {
    const report = buildReport([], { period: 'quarter', key: '2026-Q2', offsetMinutes: 480, nowMs: JUNE });
    assert.equal(report.range.kind, 'quarter');
    assert.equal(report.range.key, '2026-Q2');
    assert.equal(report.range.prevKey, '2026-Q1');
    assert.equal(report.range.isCurrent, true);
    assert.equal(resolvePeriod({ period: 'quarter', key: '2026-Q2', nowMs: JUNE }).quarter, 2);
  });
});
