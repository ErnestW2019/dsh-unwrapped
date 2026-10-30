import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePeriod,
  normalizeOffsetMinutes,
  currentKey,
  parseKey,
  shiftKey,
  resolvePeriod,
  buildSeries,
  recentKeys,
  dayIndexFromTs,
  dayKeyFromIndex,
} from '../lib/periods.js';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 5, 15, 12, 0, 0); // 2026-06-15T12:00Z

describe('periods: resolvePeriod', () => {
  it('resolves a month with the timezone offset applied to both edges', () => {
    const range = resolvePeriod({ period: 'month', key: '2026-06', offsetMinutes: 480, nowMs: NOW });
    assert.equal(range.kind, 'month');
    assert.equal(range.key, '2026-06');
    assert.equal(range.year, 2026);
    assert.equal(range.month, 6);
    assert.equal(range.quarter, null);
    assert.equal(range.startMs, Date.UTC(2026, 5, 1) - 480 * MINUTE);
    assert.equal(range.endMs, Date.UTC(2026, 6, 1) - 480 * MINUTE);
    assert.equal(range.prevKey, '2026-05');
    assert.equal(range.nextKey, '2026-07');
    assert.equal(range.offsetMinutes, 480);
  });

  it('crosses year boundaries for months', () => {
    assert.equal(resolvePeriod({ period: 'month', key: '2026-12', nowMs: NOW }).nextKey, '2027-01');
    assert.equal(resolvePeriod({ period: 'month', key: '2026-01', nowMs: NOW }).prevKey, '2025-12');
  });

  it('resolves quarters to three-month ranges', () => {
    const q2 = resolvePeriod({ period: 'quarter', key: '2026-Q2', offsetMinutes: 0, nowMs: NOW });
    assert.equal(q2.startMs, Date.UTC(2026, 3, 1));
    assert.equal(q2.endMs, Date.UTC(2026, 6, 1));
    assert.equal(q2.prevKey, '2026-Q1');
    assert.equal(q2.nextKey, '2026-Q3');
    assert.equal(resolvePeriod({ period: 'quarter', key: '2026-Q4', nowMs: NOW }).nextKey, '2027-Q1');
    assert.equal(resolvePeriod({ period: 'quarter', key: '2026-Q1', nowMs: NOW }).prevKey, '2025-Q4');
  });

  it('resolves a full year, offset included', () => {
    const year = resolvePeriod({ period: 'year', key: '2026', offsetMinutes: -300, nowMs: NOW });
    assert.equal(year.startMs, Date.UTC(2026, 0, 1) + 300 * MINUTE);
    assert.equal(year.endMs, Date.UTC(2027, 0, 1) + 300 * MINUTE);
    assert.equal(year.prevKey, '2025');
    assert.equal(year.nextKey, '2027');
  });

  it('falls back to the current period for missing or malformed keys', () => {
    const byDefault = resolvePeriod({ period: 'month', nowMs: NOW });
    assert.equal(byDefault.key, '2026-06');
    assert.equal(byDefault.isCurrent, true);
    assert.equal(resolvePeriod({ period: 'month', key: 'nope', nowMs: NOW }).key, '2026-06');
    // A month key under the quarter kind is invalid → current quarter.
    assert.equal(resolvePeriod({ period: 'quarter', key: '2026-06', nowMs: NOW }).key, '2026-Q2');
  });

  it('marks historical periods as not current', () => {
    assert.equal(resolvePeriod({ period: 'year', key: '2025', nowMs: NOW }).isCurrent, false);
    assert.equal(resolvePeriod({ period: 'month', key: '2026-06', nowMs: NOW }).isCurrent, true);
  });

  it('shifts wall-clock boundaries so the same key means local midnight', () => {
    const utc = resolvePeriod({ period: 'month', key: '2026-06', offsetMinutes: 0, nowMs: NOW });
    const shanghai = resolvePeriod({ period: 'month', key: '2026-06', offsetMinutes: 480, nowMs: NOW });
    assert.equal(utc.startMs - shanghai.startMs, 480 * MINUTE);
    assert.equal(utc.endMs - shanghai.endMs, 480 * MINUTE);
  });
});

describe('periods: buildSeries', () => {
  it('buckets a month by local day', () => {
    const range = resolvePeriod({ period: 'month', key: '2026-06', offsetMinutes: 480, nowMs: NOW });
    const series = buildSeries('month', range, 480);
    assert.equal(series.length, 30);
    assert.equal(series[0].key, '2026-06-01');
    assert.equal(series[29].key, '2026-06-30');
    assert.equal(series[0].startMs, range.startMs);
    assert.equal(series[29].endMs, range.endMs);
  });

  it('buckets a quarter into aligned seven-day chunks', () => {
    const range = resolvePeriod({ period: 'quarter', key: '2026-Q2', offsetMinutes: 480, nowMs: NOW });
    const series = buildSeries('quarter', range, 480);
    assert.equal(series.length, 13); // 91 days
    assert.equal(series[0].key, '2026-04-01');
    assert.equal(series[0].days.length, 7);
    assert.equal(series[12].key, '2026-06-24');
  });

  it('buckets a year by month and covers every day exactly once', () => {
    const range = resolvePeriod({ period: 'year', key: '2026', offsetMinutes: 480, nowMs: NOW });
    const series = buildSeries('year', range, 480);
    assert.equal(series.length, 12);
    assert.equal(series[0].key, '2026-01');
    assert.equal(series[11].key, '2026-12');
    const days = series.flatMap((bucket) => bucket.days);
    assert.equal(days.length, 365);
    assert.equal(new Set(days).size, 365);
    assert.equal(days[0], dayIndexFromTs(range.startMs, 480));
  });
});

describe('periods: helpers', () => {
  it('round-trips day indexes through day keys', () => {
    const index = dayIndexFromTs(Date.UTC(2026, 5, 15, 3, 30), 480);
    assert.equal(dayKeyFromIndex(index), '2026-06-15');
  });

  it('normalizes offsets and rejects absurd values', () => {
    assert.equal(normalizeOffsetMinutes(480), 480);
    assert.equal(normalizeOffsetMinutes('-240'), -240);
    assert.equal(normalizeOffsetMinutes('abc', 0), 0);
    assert.equal(normalizeOffsetMinutes(5000, 0), 0);
    assert.equal(normalizeOffsetMinutes(undefined, 0), 0);
  });

  it('defaults unknown period kinds to month', () => {
    assert.equal(normalizePeriod('week'), 'month');
    assert.equal(normalizePeriod('QUARTER'), 'quarter');
    assert.equal(normalizePeriod(undefined), 'month');
  });

  it('shifts keys and rejects malformed input', () => {
    assert.equal(shiftKey('month', '2026-01', -1), '2025-12');
    assert.equal(shiftKey('quarter', '2026-Q1', -1), '2025-Q4');
    assert.equal(shiftKey('year', '2026', 1), '2027');
    assert.equal(shiftKey('month', 'bogus', 1), null);
    assert.equal(parseKey('month', '2026-13'), null);
    assert.equal(parseKey('quarter', '2026-Q5'), null);
    assert.deepEqual(parseKey('month', '2026-06'), { year: 2026, month: 6 });
  });

  it('enumerates recent keys newest-last', () => {
    assert.deepEqual(recentKeys('month', '2026-02', 3), ['2025-12', '2026-01', '2026-02']);
  });
});
