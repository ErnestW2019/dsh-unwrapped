/**
 * Facts → rewind report. Pure: no I/O, no clock (the caller passes `nowMs`),
 * so every rule below is unit-testable against synthetic session facts.
 */

import {
  dayIndexFromTs,
  dayKeyFromIndex,
  shiftTs,
  buildSeries,
  resolvePeriod,
} from './periods.js';

/** A gap longer than this ends a "sitting" for the marathon badge. */
const CONTINUOUS_GAP_MS = 30 * 60 * 1000;

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function share(part, total) {
  const p = toInt(part);
  const t = toInt(total);
  return t > 0 ? Number((p / t).toFixed(4)) : 0;
}

/** Percentage change; null means "no comparable baseline". */
function deltaPct(current, previous) {
  const cur = Number(current) || 0;
  const prev = Number(previous) || 0;
  if (prev <= 0) return cur > 0 ? null : 0;
  return Number((((cur - prev) / prev) * 100).toFixed(1));
}

function inWindow(points, startMs, endMs) {
  return points.filter((p) => p.t >= startMs && p.t < endMs);
}

function sumBy(list, pick) {
  let total = 0;
  for (const item of list) total += pick(item);
  return total;
}

function topEntries(map, limit, keyName) {
  return Object.entries(map)
    .filter(([, count]) => toInt(count) > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, count]) => ({ [keyName]: key, count: toInt(count) }));
}

/** Longest run of consecutive active local days. */
function maxStreak(dayIndexes) {
  const days = [...new Set(dayIndexes.map(toInt))].sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  let prev = null;
  for (const day of days) {
    run = prev !== null && day === prev + 1 ? run + 1 : 1;
    if (run > best) best = run;
    prev = day;
  }
  return best;
}

/**
 * Pick the top phrases, dropping a shorter phrase that is contained in a
 * longer one — 「再试试」 already covers 「再试」 and 「试试」.
 */
function rankPhrases(counts, limit = 3, minCount = 2) {
  const entries = Object.entries(counts)
    .filter(([, count]) => count >= minCount)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]));
  const picked = [];
  for (const [word, count] of entries) {
    if (picked.some((hit) => hit.word.includes(word) || word.includes(hit.word))) continue;
    picked.push({ word, count });
    if (picked.length >= limit) break;
  }
  return picked;
}

/** Lightweight totals for one window — used for the period-over-period delta. */
function windowTotals(facts, startMs, endMs) {
  let human = 0;
  let ai = 0;
  let sessions = 0;
  let tokens = 0;
  for (const fact of facts) {
    const humanPoints = inWindow(fact.humanPoints, startMs, endMs);
    const aiPoints = inWindow(fact.assistantPoints, startMs, endMs);
    if (humanPoints.length === 0 && aiPoints.length === 0) continue;
    sessions += 1;
    human += humanPoints.length;
    ai += aiPoints.filter((point) => point.chars > 0).length;
    for (const point of aiPoints) tokens += point.tokens ? point.tokens.total : 0;
  }
  return { human, ai, messages: human + ai, sessions, tokens };
}

function emptyReport(range) {
  return {
    range,
    hasData: false,
    totals: {
      messages: 0,
      humanMessages: 0,
      aiMessages: 0,
      humanChars: 0,
      aiChars: 0,
      reasoningChars: 0,
      turns: 0,
      steps: 0,
      toolCalls: 0,
      sessionsTouched: 0,
      sessionsCreated: 0,
      activeDays: 0,
      maxStreak: 0,
      avgMessagesPerSession: 0,
      humanAvgChars: 0,
      aiAvgChars: 0,
      longestSpanMs: 0,
      interrupted: 0,
      failures: 0,
      injectedMessages: 0,
      delegatedSessions: 0,
      busiestDay: null,
      peakHour: null,
    },
    ratio: { humanShare: 0, aiShare: 0, humanToAi: null },
    series: [],
    hours: new Array(24).fill(0),
    weekday: new Array(7).fill(0),
    tokens: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, requests: 0 },
    topModels: [],
    topProviders: [],
    topWorkspaces: [],
    topPresets: [],
    tools: [],
    topSessions: [],
    failures: { count: 0, samples: [] },
    moments: { first: null, last: null, latestNight: null, latestClock: null, longest: null, timeline: [], questions: 0, thanks: 0, samples: 0 },
    phrases: [],
    comparison: { prevKey: range.prevKey, human: 0, ai: 0, sessions: 0, tokens: 0, deltas: { messagesPct: null, sessionsPct: null, tokensPct: null } },
    badges: [],
    headline: null,
    generatedAt: Date.now(),
  };
}

/**
 * Aggregate every session's facts into one period report.
 * @param {object[]} facts - output of extractSession()
 * @param {{ period?: string, key?: string, offsetMinutes?: number, nowMs?: number }} query
 * @returns {object} report
 */
function buildReport(facts, query = {}) {
  const period = resolvePeriod(query);
  const offset = period.offsetMinutes;
  const { startMs, endMs } = period;
  const report = emptyReport(period);
  const list = Array.isArray(facts) ? facts : [];

  /** @type {Map<string, number>} */
  const hours = new Map();
  /** @type {Map<string, number>} */
  const weekday = new Map();
  /** @type {Map<number, { human: number, ai: number }>} */
  const byDay = new Map();
  /** @type {Record<string, number>} */
  const modelCounts = {};
  /** @type {Record<string, number>} */
  const providerCounts = {};
  /** @type {Record<string, number>} */
  const workspaceCounts = {};
  /** @type {Record<string, number>} */
  const presetCounts = {};
  /** @type {Record<string, number>} */
  const toolCounts = {};
  /** @type {object[]} */
  const sessionSummaries = [];
  /** @type {{ t: number, message: string }[]} */
  const failureSamples = [];
  /** @type {{ t: number, text: string, sessionId: string, title: string }[]} */
  const allSamples = [];
  /** @type {Record<string, number>} */
  const phraseCounts = {};
  let bestRun = 0;
  let bestRunSession = null;

  let humanMessages = 0;
  let aiMessages = 0;
  let aiSteps = 0;
  let humanChars = 0;
  let aiChars = 0;
  let reasoningChars = 0;
  let turns = 0;
  let steps = 0;
  let toolCalls = 0;
  let sessionsTouched = 0;
  let sessionsCreated = 0;
  let interrupted = 0;
  let failureCount = 0;
  let injectedMessages = 0;
  let delegatedSessions = 0;
  let longestSpanMs = 0;
  let longestRunMs = 0;
  const tokens = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };

  for (const fact of list) {
    const humanPoints = inWindow(fact.humanPoints, startMs, endMs);
    const aiPoints = inWindow(fact.assistantPoints, startMs, endMs);
    const toolPoints = inWindow(fact.toolPoints, startMs, endMs);
    const turnPoints = inWindow(fact.turnPoints, startMs, endMs);
    const stepPoints = inWindow(fact.stepPoints, startMs, endMs);
    const failurePoints = inWindow(fact.failures, startMs, endMs);
    const samplePoints = Array.isArray(fact.humanSamples)
      ? fact.humanSamples.filter((sample) => sample && sample.t >= startMs && sample.t < endMs)
      : [];

    if (fact.createdAt >= startMs && fact.createdAt < endMs) sessionsCreated += 1;

    const touched = humanPoints.length + aiPoints.length + toolPoints.length + turnPoints.length + stepPoints.length;
    if (touched === 0) continue;
    sessionsTouched += 1;
    if (fact.delegationDepth > 0 || fact.origin === 'subagent') delegatedSessions += 1;

    // One human prompt typically produces several assistant messages: the
    // agent speaks, then issues tool calls, then speaks again. Only the ones
    // that actually carry visible text count as "AI spoke"; the rest are steps.
    const spoken = aiPoints.filter((point) => point.chars > 0);

    humanMessages += humanPoints.length;
    aiMessages += spoken.length;
    aiSteps += aiPoints.length;
    humanChars += sumBy(humanPoints, (p) => p.chars);
    aiChars += sumBy(spoken, (p) => p.chars);
    reasoningChars += sumBy(aiPoints, (p) => p.reasoningChars);
    turns += turnPoints.length;
    steps += stepPoints.length;
    toolCalls += toolPoints.length;
    interrupted += fact.interrupted;
    injectedMessages += fact.injectedMessages;

    for (const point of aiPoints) {
      if (!point.tokens) continue;
      tokens.input += point.tokens.input;
      tokens.output += point.tokens.output;
      tokens.total += point.tokens.total;
      tokens.cacheRead += point.tokens.cacheRead;
      tokens.cacheWrite += point.tokens.cacheWrite;
      tokens.requests += 1;
    }

    for (const point of toolPoints) toolCounts[point.name] = (toolCounts[point.name] ?? 0) + 1;
    // Model/provider mix is counted per AI message inside the window (not per
    // session), so a long-lived session cannot dominate the distribution.
    for (const point of aiPoints) {
      if (point.model) modelCounts[point.model] = (modelCounts[point.model] ?? 0) + 1;
      if (point.provider) providerCounts[point.provider] = (providerCounts[point.provider] ?? 0) + 1;
    }
    if (fact.cwd) workspaceCounts[fact.cwd] = (workspaceCounts[fact.cwd] ?? 0) + humanPoints.length + aiPoints.length;
    if (fact.agentPreset) presetCounts[fact.agentPreset] = (presetCounts[fact.agentPreset] ?? 0) + 1;

    for (const point of [...humanPoints, ...spoken]) {
      const h = new Date(shiftTs(point.t, offset)).getUTCHours();
      hours.set(h, (hours.get(h) ?? 0) + 1);
      const dayIndex = dayIndexFromTs(point.t, offset);
      const weekdayIndex = (((dayIndex + 4) % 7) + 7) % 7;
      weekday.set(weekdayIndex, (weekday.get(weekdayIndex) ?? 0) + 1);
    }
    for (const point of humanPoints) {
      const dayIndex = dayIndexFromTs(point.t, offset);
      const bucket = byDay.get(dayIndex) ?? { human: 0, ai: 0 };
      bucket.human += 1;
      byDay.set(dayIndex, bucket);
    }
    for (const point of spoken) {
      const dayIndex = dayIndexFromTs(point.t, offset);
      const bucket = byDay.get(dayIndex) ?? { human: 0, ai: 0 };
      bucket.ai += 1;
      byDay.set(dayIndex, bucket);
    }

    for (const failure of failurePoints) failureCount += 1;
    for (const failure of failurePoints.slice(0, 2)) {
      if (failureSamples.length < 4) failureSamples.push({ t: failure.t, message: failure.message });
    }

    const allTimes = [...humanPoints, ...aiPoints, ...toolPoints].map((p) => p.t);
    const firstTs = allTimes.length ? Math.min(...allTimes) : 0;
    const lastTs = allTimes.length ? Math.max(...allTimes) : 0;
    const spanMs = Math.max(0, lastTs - firstTs);
    if (spanMs > longestSpanMs) longestSpanMs = spanMs;

    // Longest unbroken sitting: consecutive events less than the gap apart.
    // A session open for a week is not a marathon; three hours straight is.
    const ordered = [...allTimes, ...turnPoints.map((p) => p.t), ...stepPoints.map((p) => p.t)].sort((a, b) => a - b);
    let runStart = 0;
    let previous = null;
    let sessionRun = 0;
    let sessionRunStart = 0;
    for (const t of ordered) {
      if (previous === null || t - previous > CONTINUOUS_GAP_MS) runStart = t;
      if (t - runStart > longestRunMs) longestRunMs = t - runStart;
      if (t - runStart > sessionRun) {
        sessionRun = t - runStart;
        sessionRunStart = runStart;
      }
      previous = t;
    }
    if (sessionRun > bestRun) {
      bestRun = sessionRun;
      bestRunSession = { id: fact.id, title: fact.title || '', runMs: sessionRun, startTs: sessionRunStart };
    }

    for (const sample of samplePoints) {
      if (!sample.text) continue;
      allSamples.push({ t: sample.t, text: sample.text, sessionId: fact.id, title: fact.title || '' });
    }
    if (fact.phrases && typeof fact.phrases === 'object') {
      for (const [word, count] of Object.entries(fact.phrases)) {
        if (!Number.isFinite(count) || count <= 0) continue;
        phraseCounts[word] = (phraseCounts[word] ?? 0) + count;
      }
    }

    sessionSummaries.push({
      id: fact.id,
      title: fact.title || '',
      cwd: fact.cwd || '',
      agentPreset: fact.agentPreset || '',
      delegated: fact.delegationDepth > 0 || fact.origin === 'subagent',
      human: humanPoints.length,
      ai: spoken.length,
      steps: aiPoints.length,
      messages: humanPoints.length + spoken.length,
      chars: sumBy(humanPoints, (p) => p.chars) + sumBy(spoken, (p) => p.chars),
      tokens: sumBy(aiPoints, (p) => (p.tokens ? p.tokens.total : 0)),
      tools: toolPoints.length,
      spanMs,
      startTs: firstTs,
      endTs: lastTs,
      previews: Array.isArray(fact.previews) ? fact.previews.slice(0, 3) : [],
    });
  }

  const messages = humanMessages + aiMessages;
  const dayIndexes = [...byDay.keys()];
  const busiest = dayIndexes
    .map((day) => ({ day, messages: byDay.get(day).human + byDay.get(day).ai }))
    .sort((a, b) => b.messages - a.messages || a.day - b.day)[0] ?? null;

  let peakHour = null;
  for (const [hour, count] of [...hours.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])) {
    if (count > 0) { peakHour = Number(hour); break; }
  }

  const buckets = buildSeries(period.kind, period, offset);
  const series = buckets.map((bucket) => {
    let human = 0;
    let ai = 0;
    for (const day of bucket.days) {
      const entry = byDay.get(day);
      if (!entry) continue;
      human += entry.human;
      ai += entry.ai;
    }
    return { key: bucket.key, human, ai, total: human + ai };
  });

  // ── "what you actually said" ────────────────────────────────────────────
  // A rewind earns its keep on specifics, not ratios: the first and last thing
  // said, the latest hour, the phrase you kept repeating.
  const samples = allSamples.slice().sort((a, b) => a.t - b.t);
  const sampleByDay = new Map();
  for (const sample of samples) {
    const day = dayIndexFromTs(sample.t, offset);
    if (!sampleByDay.has(day)) sampleByDay.set(day, sample);
  }
  const pick = (sample) => (sample ? { t: sample.t, text: sample.text, title: sample.title, id: sample.sessionId } : null);

  let latestNight = null;
  let latestScore = -1;
  let latestClock = null;
  let clockScore = -1;
  for (const sample of samples) {
    const local = new Date(shiftTs(sample.t, offset));
    const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
    if (minutes > clockScore) {
      clockScore = minutes;
      latestClock = { ...pick(sample), hour: local.getUTCHours(), minute: local.getUTCMinutes() };
    }
    // 21:00 → 0, 23:10 → 130, 00:00 → 180, 03:40 → 400: later in the night wins.
    // The window is 21:00–06:00, so an evening-at-19:05 message is not "late".
    const score = (((minutes - 21 * 60) % 1440) + 1440) % 1440;
    if (score >= 540) continue;
    if (score > latestScore) {
      latestScore = score;
      latestNight = { ...pick(sample), hour: local.getUTCHours(), minute: local.getUTCMinutes() };
    }
  }

  let questions = 0;
  let thanks = 0;
  for (const fact of list) {
    for (const mark of inWindow(fact.humanMarks, startMs, endMs)) {
      questions += Number(mark.questions) || 0;
      thanks += Number(mark.thanks) || 0;
    }
  }

  const timeline = [];
  for (const bucket of buckets) {
    let hit = null;
    for (const day of bucket.days) {
      const sample = sampleByDay.get(day);
      if (sample) { hit = { key: bucket.key, t: sample.t, text: sample.text }; break; }
    }
    if (hit) timeline.push(hit);
  }
  const timelineStep = timeline.length > 8 ? Math.ceil(timeline.length / 8) : 1;

  report.moments = {
    first: pick(samples[0]),
    last: pick(samples[samples.length - 1]),
    latestNight,
    latestClock,
    longest: bestRunSession,
    timeline: timelineStep > 1 ? timeline.filter((_, index) => index % timelineStep === 0) : timeline,
    questions,
    thanks,
    samples: samples.length,
  };
  report.phrases = rankPhrases(phraseCounts, 3);

  const humanAvgChars = humanMessages > 0 ? Math.round(humanChars / humanMessages) : 0;
  const aiAvgChars = aiMessages > 0 ? Math.round(aiChars / aiMessages) : 0;
  const avgMessagesPerSession = sessionsTouched > 0 ? Number((messages / sessionsTouched).toFixed(1)) : 0;

  report.hasData = messages > 0 || tokens.requests > 0 || toolCalls > 0;
  report.totals = {
    messages,
    humanMessages,
    aiMessages,
    aiSteps,
    humanChars,
    aiChars,
    reasoningChars,
    turns,
    steps,
    toolCalls,
    sessionsTouched,
    sessionsCreated,
    messagesPerSession: avgMessagesPerSession,
    avgMessagesPerSession,
    activeDays: dayIndexes.length,
    maxStreak: maxStreak(dayIndexes),
    humanAvgChars,
    aiAvgChars,
    longestSpanMs,
    longestRunMs,
    interrupted,
    failures: failureCount,
    injectedMessages,
    delegatedSessions,
    busiestDay: busiest ? { day: dayKeyFromIndex(busiest.day), messages: busiest.messages } : null,
    peakHour,
  };
  report.ratio = {
    humanShare: share(humanMessages, messages),
    aiShare: share(aiMessages, messages),
    humanToAi: aiMessages > 0 ? Number((humanMessages / aiMessages).toFixed(2)) : null,
  };
  report.series = series;
  report.hours = Array.from({ length: 24 }, (_, h) => hours.get(h) ?? 0);
  report.weekday = Array.from({ length: 7 }, (_, index) => weekday.get(index) ?? 0);
  report.tokens = tokens;
  report.topModels = topEntries(modelCounts, 5, 'model');
  report.topProviders = topEntries(providerCounts, 5, 'provider');
  report.topWorkspaces = topEntries(workspaceCounts, 5, 'workspace');
  report.topPresets = topEntries(presetCounts, 5, 'preset');
  report.tools = topEntries(toolCounts, 6, 'name');
  report.topSessions = sessionSummaries
    .filter((session) => session.messages > 0)
    .sort((a, b) => b.messages - a.messages || b.tokens - a.tokens)
    .slice(0, 6);
  report.failures = { count: failureCount, samples: failureSamples };

  const previous = windowTotals(list, startMs - (endMs - startMs), startMs);
  report.comparison = {
    prevKey: period.prevKey,
    human: previous.human,
    ai: previous.ai,
    sessions: previous.sessions,
    tokens: previous.tokens,
    deltas: {
      messagesPct: deltaPct(messages, previous.messages),
      sessionsPct: deltaPct(sessionsTouched, previous.sessions),
      tokensPct: deltaPct(tokens.total, previous.tokens),
    },
  };

  report.badges = deriveBadges(report);
  report.headline = report.badges[0] ?? null;
  report.corpus = corpusSummary(list);
  report.generatedAt = Date.now();
  return report;
}

function corpusSummary(facts) {
  let sessions = 0;
  let firstAt = 0;
  let lastAt = 0;
  for (const fact of facts) {
    sessions += 1;
    const created = toInt(fact.createdAt);
    if (created > 0 && (!firstAt || created < firstAt)) firstAt = created;
    const last = toInt(fact.lastTs);
    if (last > lastAt) lastAt = last;
  }
  return { sessions, firstAt, lastAt };
}

/**
 * Fun badges. Each entry is an i18n key plus one interpolation metric, capped
 * at four and ordered by how much it says about the period.
 */
function deriveBadges(report) {
  const t = report.totals;
  if (toInt(t.messages) < 5) return [];
  const badges = [];
  const peak = t.peakHour;

  if (peak !== null && (peak >= 22 || peak <= 4)) badges.push({ key: 'night_owl', metric: peak, priority: 96 });
  if (peak !== null && peak >= 5 && peak <= 8) badges.push({ key: 'early_bird', metric: peak, priority: 72 });
  if (t.longestRunMs >= 3 * 60 * 60 * 1000) badges.push({ key: 'marathon', metric: Math.round(t.longestRunMs / 60000), priority: 84 });
  if (t.maxStreak >= 7) badges.push({ key: 'streak_keeper', metric: t.maxStreak, priority: 90 });
  if (report.topProviders.length >= 3) badges.push({ key: 'provider_hopper', metric: report.topProviders.length, priority: 66 });
  if (report.topModels.length >= 3) badges.push({ key: 'model_polyglot', metric: report.topModels.length, priority: 62 });
  if (report.tools.length >= 5) badges.push({ key: 'tool_master', metric: report.tools.length, priority: 64 });
  if (t.humanMessages >= 30 && t.humanAvgChars > 0 && t.humanAvgChars <= 40) badges.push({ key: 'terse', metric: t.humanAvgChars, priority: 58 });
  if (t.humanAvgChars >= 280) badges.push({ key: 'storyteller', metric: t.humanAvgChars, priority: 58 });
  if (t.avgMessagesPerSession >= 60) badges.push({ key: 'deep_diver', metric: Math.round(t.avgMessagesPerSession), priority: 80 });
  if (t.sessionsTouched >= 30) badges.push({ key: 'prolific', metric: t.sessionsTouched, priority: 54 });
  const totalTokens = Number(report.tokens?.total) || 0;
  if (totalTokens >= 5_000_000) badges.push({ key: 'token_whale', metric: totalTokens, priority: 52 });
  if (toInt(t.delegatedSessions) >= 3) badges.push({ key: 'delegation_chief', metric: t.delegatedSessions, priority: 68 });
  if (t.failures >= 10) badges.push({ key: 'resilient', metric: t.failures, priority: 50 });

  return badges
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 4)
    .map(({ key, metric }) => ({ key, metric }));
}

export {
  buildReport,
  deriveBadges,
  windowTotals,
  maxStreak,
  rankPhrases,
  share,
  deltaPct,
  WEEKDAY_LABELS,
};
