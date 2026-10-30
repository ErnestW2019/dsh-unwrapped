/**
 * Period math for the rewind report — pure functions, no I/O.
 *
 * Time zones: instead of relying on a tz database, callers pass
 * `offsetMinutes` (east positive: Asia/Shanghai = 480). Every "local wall
 * clock" computation shifts the epoch first and then reads UTC getters, so the
 * host and the browser agree bit-for-bit.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const PERIOD_KINDS = ['month', 'quarter', 'year'];
const MAX_OFFSET_MINUTES = 14 * 60;

/** @param {unknown} period @returns {'month'|'quarter'|'year'} */
function normalizePeriod(period) {
  const value = String(period ?? '').trim().toLowerCase();
  return PERIOD_KINDS.includes(value) ? value : 'month';
}

/** @param {unknown} value @param {number} [fallback] @returns {number} */
function normalizeOffsetMinutes(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const truncated = Math.trunc(n);
  return Math.abs(truncated) > MAX_OFFSET_MINUTES ? fallback : truncated;
}

function shiftTs(ts, offsetMinutes) {
  return ts + offsetMinutes * MINUTE_MS;
}

function unshiftTs(ts, offsetMinutes) {
  return ts - offsetMinutes * MINUTE_MS;
}

/** Local calendar day index (days since 1970-01-01 in the shifted frame). */
function dayIndexFromTs(ts, offsetMinutes = 0) {
  return Math.floor(shiftTs(ts, offsetMinutes) / DAY_MS);
}

/** Day index → 'YYYY-MM-DD'. */
function dayKeyFromIndex(dayIndex) {
  return new Date(dayIndex * DAY_MS).toISOString().slice(0, 10);
}

const pad2 = (n) => String(n).padStart(2, '0');
const monthKey = (year, month) => `${year}-${pad2(month)}`;
const quarterKey = (year, quarter) => `${year}-Q${quarter}`;

/** Current period key in the caller's local time. */
function currentKey(kind, nowMs = Date.now(), offsetMinutes = 0) {
  const local = new Date(shiftTs(nowMs, offsetMinutes));
  const year = local.getUTCFullYear();
  if (kind === 'year') return String(year);
  if (kind === 'quarter') return quarterKey(year, Math.floor(local.getUTCMonth() / 3) + 1);
  return monthKey(year, local.getUTCMonth() + 1);
}

/** Parse 'YYYY-MM' | 'YYYY-Qn' | 'YYYY' into parts; null when malformed. */
function parseKey(kind, key) {
  const raw = String(key ?? '').trim();
  if (!raw) return null;
  if (kind === 'month') {
    const m = /^(\d{4})-(\d{1,2})$/.exec(raw);
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (year < 1970 || year > 3000 || month < 1 || month > 12) return null;
    return { year, month };
  }
  if (kind === 'quarter') {
    const m = /^(\d{4})-?Q([1-4])$/i.exec(raw);
    if (!m) return null;
    const year = Number(m[1]);
    if (year < 1970 || year > 3000) return null;
    return { year, quarter: Number(m[2]) };
  }
  const m = /^(\d{4})$/.exec(raw);
  if (!m) return null;
  const year = Number(m[1]);
  return year < 1970 || year > 3000 ? null : { year };
}

/** Local-midnight coordinate of a period start (still shifted). */
function localStartOf(kind, parts) {
  if (kind === 'year') return Date.UTC(parts.year, 0, 1);
  if (kind === 'quarter') return Date.UTC(parts.year, (parts.quarter - 1) * 3, 1);
  return Date.UTC(parts.year, parts.month - 1, 1);
}

/** Local-midnight coordinate of the following period start. */
function localNextOf(kind, parts) {
  if (kind === 'year') return Date.UTC(parts.year + 1, 0, 1);
  if (kind === 'quarter') {
    return parts.quarter === 4
      ? Date.UTC(parts.year + 1, 0, 1)
      : Date.UTC(parts.year, parts.quarter * 3, 1);
  }
  return parts.month === 12 ? Date.UTC(parts.year + 1, 0, 1) : Date.UTC(parts.year, parts.month, 1);
}

/** Local-midnight coordinate of the preceding period start. */
function localPrevOf(kind, parts) {
  if (kind === 'year') return Date.UTC(parts.year - 1, 0, 1);
  if (kind === 'quarter') {
    return parts.quarter === 1
      ? Date.UTC(parts.year - 1, 9, 1)
      : Date.UTC(parts.year, (parts.quarter - 2) * 3, 1);
  }
  return parts.month === 1 ? Date.UTC(parts.year - 1, 11, 1) : Date.UTC(parts.year, parts.month - 2, 1);
}

function keyOfLocalStart(kind, localMs) {
  const d = new Date(localMs);
  const year = d.getUTCFullYear();
  if (kind === 'year') return String(year);
  if (kind === 'quarter') return quarterKey(year, Math.floor(d.getUTCMonth() / 3) + 1);
  return monthKey(year, d.getUTCMonth() + 1);
}

/** Move a key by `delta` whole periods. */
function shiftKey(kind, key, delta) {
  const parts = parseKey(kind, key);
  if (!parts) return null;
  const step = Math.trunc(Number(delta) || 0);
  let localMs = localStartOf(kind, parts);
  if (step !== 0) {
    if (kind === 'year') localMs = Date.UTC(parts.year + step, 0, 1);
    else if (kind === 'quarter') localMs = Date.UTC(parts.year, parts.quarter - 1 + step * 3, 1);
    else localMs = Date.UTC(parts.year, parts.month - 1 + step, 1);
  }
  return keyOfLocalStart(kind, localMs);
}

/**
 * Resolve one query into a half-open range `[startMs, endMs)` plus neighbours.
 * A missing or malformed key falls back to the current period.
 */
function resolvePeriod({ period, key, offsetMinutes, nowMs = Date.now() } = {}) {
  const kind = normalizePeriod(period);
  const offset = normalizeOffsetMinutes(offsetMinutes, 0);
  const fallbackKey = currentKey(kind, nowMs, offset);
  const parts = parseKey(kind, key) || parseKey(kind, fallbackKey) || { year: 1970, month: 1, quarter: 1 };
  const localStart = localStartOf(kind, parts);
  const localEnd = localNextOf(kind, parts);
  const canonicalKey = keyOfLocalStart(kind, localStart);
  return {
    kind,
    key: canonicalKey,
    year: parts.year,
    month: kind === 'month' ? parts.month : null,
    quarter: kind === 'quarter' ? parts.quarter : null,
    startMs: unshiftTs(localStart, offset),
    endMs: unshiftTs(localEnd, offset),
    prevKey: keyOfLocalStart(kind, localPrevOf(kind, parts)),
    nextKey: keyOfLocalStart(kind, localNextOf(kind, parts)),
    isCurrent: canonicalKey === fallbackKey,
    offsetMinutes: offset,
  };
}

function dayIndexesBetween(fromLocalMs, toLocalMs) {
  const first = Math.floor(fromLocalMs / DAY_MS);
  const last = Math.ceil(toLocalMs / DAY_MS) - 1;
  const out = [];
  for (let d = first; d <= last; d += 1) out.push(d);
  return out;
}

/**
 * Chart buckets: month → days, quarter → aligned weeks, year → months.
 * Each bucket carries the local day indexes it owns so per-day facts fold in
 * without a second pass over the range.
 */
function buildSeries(kind, range, offsetMinutes = 0) {
  const localStart = shiftTs(range.startMs, offsetMinutes);
  const localEnd = shiftTs(range.endMs, offsetMinutes);
  const buckets = [];
  if (kind === 'year') {
    const year = new Date(localStart).getUTCFullYear();
    for (let month = 0; month < 12; month += 1) {
      const from = Date.UTC(year, month, 1);
      if (from >= localEnd) break;
      const to = Math.min(Date.UTC(year, month + 1, 1), localEnd);
      buckets.push({
        key: monthKey(year, month + 1),
        startMs: unshiftTs(from, offsetMinutes),
        endMs: unshiftTs(to, offsetMinutes),
        days: dayIndexesBetween(from, to),
      });
    }
    return buckets;
  }
  const chunkDays = kind === 'quarter' ? 7 : 1;
  for (let from = localStart; from < localEnd; from += chunkDays * DAY_MS) {
    const to = Math.min(from + chunkDays * DAY_MS, localEnd);
    buckets.push({
      key: dayKeyFromIndex(Math.floor(from / DAY_MS)),
      startMs: unshiftTs(from, offsetMinutes),
      endMs: unshiftTs(to, offsetMinutes),
      days: dayIndexesBetween(from, to),
    });
  }
  return buckets;
}

/** Enumerate the `count` period keys ending at (and including) `key`. */
function recentKeys(kind, key, count) {
  const out = [];
  let cursor = key;
  for (let i = 0; i < Math.max(1, Math.trunc(Number(count) || 1)); i += 1) {
    if (cursor === null) break;
    out.unshift(cursor);
    cursor = shiftKey(kind, cursor, -1);
  }
  return out;
}

export {
  DAY_MS,
  MINUTE_MS,
  PERIOD_KINDS,
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
  shiftTs,
  unshiftTs,
};
