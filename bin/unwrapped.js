#!/usr/bin/env node
/**
 * Offline CLI: turn a durable session archive into a rewind report without a
 * running harness.
 *
 *   node bin/unwrapped.js --period month --key 2026-06 --out rewind.html
 *   node bin/unwrapped.js --period year --lang en --json report.json --stdout
 *
 * Defaults to `$DSH_HOME/sessions` (or `~/.dsh/sessions`), which is exactly the
 * archive the plugin itself reads through `ctx.sessionQuery`.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { buildReport } from '../lib/aggregate.js';
import { loadFactsFromArchive } from '../lib/sources.js';
import { renderReport } from '../lib/report.js';
import { resolvePeriod, recentKeys } from '../lib/periods.js';
import { formatCompact, formatDate, formatInt } from '../lib/report.js';
import { packFor } from '../lib/labels.js';

const HELP = `dsh-unwrapped — build a conversation rewind report offline

Usage: node bin/unwrapped.js [options]

Options:
  --archive <dir>     session archive root (default: $DSH_HOME/sessions)
  --period <kind>     month | quarter | year (default: month)
  --key <key>         2026-06 | 2026-Q2 | 2026 (default: current period)
  --tz <minutes>      timezone offset, east positive (default: system)
  --lang <zh|en>      report language (default: zh)
  --max-sessions <n>  newest N sessions to read (default: 800)
  --out <file>        write HTML here (default: rewind.html)
  --json <file>       also write the raw report JSON here
  --stdout            print the HTML to stdout instead of a file
  --embed <n>         also embed the last N periods so the file can switch offline (default: 0)
  --no-write          read + summarize only, write nothing
  -h, --help          show this help
`;

const DEFAULTS = {
  archive: process.env.DSH_HOME ? join(process.env.DSH_HOME, 'sessions') : join(homedir(), '.dsh', 'sessions'),
  period: 'month',
  key: undefined,
  tz: -new Date().getTimezoneOffset(),
  lang: 'zh',
  maxSessions: 800,
  out: 'rewind.html',
  json: undefined,
  stdout: false,
  write: true,
  embed: 0,
};

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '--archive':
        options.archive = next();
        break;
      case '--period':
        options.period = next();
        break;
      case '--key':
        options.key = next();
        break;
      case '--tz':
        options.tz = Number(next());
        break;
      case '--lang':
        options.lang = next();
        break;
      case '--max-sessions':
        options.maxSessions = Number(next());
        break;
      case '--out':
        options.out = next();
        break;
      case '--json':
        options.json = next();
        break;
      case '--stdout':
        options.stdout = true;
        break;
      case '--embed':
        options.embed = Number(next());
        break;
      case '--no-write':
        options.write = false;
        break;
      default:
        if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`);
        throw new Error(`unexpected argument: ${arg}`);
    }
  }
  return options;
}

function summarize(report, lang) {
  const L = packFor(lang);
  const period = report.range ?? report.period;
  const offset = period.offsetMinutes || 0;
  const lines = [];
  lines.push(`${L.periodOf(period)}  (${period.key})`);
  if (!report.hasData) {
    lines.push('  no conversation activity in this period');
    return lines.join('\n');
  }
  const t = report.totals;
  lines.push(`  ${L.ratioHuman}: ${formatInt(t.humanMessages)}  ${L.ratioAi}: ${formatInt(t.aiMessages)}  ·  ${formatInt(t.turns)} rounds  ·  ${formatInt(t.aiSteps)} AI steps  ·  ${formatInt(t.sessionsTouched)} sessions`);
  lines.push(`  chars: ${formatCompact(t.humanChars, L)} human / ${formatCompact(t.aiChars, L)} AI  ·  tokens: ${formatCompact(report.tokens.total, L)}  ·  tools: ${formatInt(t.toolCalls)}`);
  lines.push(`  active days: ${t.activeDays}  ·  streak: ${t.maxStreak}  ·  peak: ${t.peakHour === null ? '—' : `${String(t.peakHour).padStart(2, '0')}:00`}`);
  if (report.badges.length) lines.push(`  badges: ${report.badges.map((b) => b.key).join(', ')}`);
  if (report.topSessions.length) {
    lines.push('  top sessions:');
    for (const session of report.topSessions.slice(0, 3)) {
      lines.push(`    - ${session.title || session.id} (${formatInt(session.messages)} msgs, ${formatCompact(session.tokens, L)} tokens, ${formatDate(session.startTs, offset)})`);
    }
  }
  return lines.join('\n');
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    console.error(`error: ${err.message}\n`);
    console.error(HELP);
    return 2;
  }
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  if (!existsSync(options.archive)) {
    console.error(`error: archive not found: ${options.archive}`);
    return 1;
  }

  const period = resolvePeriod({ period: options.period, key: options.key, offsetMinutes: options.tz });
  const facts = loadFactsFromArchive(options.archive, {
    maxSessions: options.maxSessions,
    onError: (err, id) => console.error(`warn: skipped session ${id}: ${err.message}`),
  });
  if (facts.length === 0) {
    console.error(`error: no readable session logs under ${options.archive}`);
    return 1;
  }

  const report = buildReport(facts, { period: period.kind, key: period.key, offsetMinutes: options.tz });
  console.log(summarize(report, options.lang));

  // Embedded alternates make the exported file self-sufficient: the same
  // scrubber window the live page offers is baked in as inert templates, so a
  // double-clicked report still switches periods (no server, no fetch).
  const embedCount = Math.max(0, Math.min(60, Math.trunc(Number(options.embed) || 0)));
  const embedKeys = embedCount > 0
    ? recentKeys(period.kind, period.key, embedCount + 1).filter((key) => key !== period.key)
    : [];
  const alternates = embedKeys.map((key) => ({
    key,
    report: buildReport(facts, { period: period.kind, key, offsetMinutes: options.tz }),
  }));
  const embeddedKeys = new Set([period.key, ...embedKeys]);
  const hrefFor = embedCount > 0
    ? (kind, key) => (key && embeddedKeys.has(key) ? `#${key}` : null)
    : null;

  const html = renderReport({ report, lang: options.lang, hrefFor, alternates });

  if (options.stdout) console.log(html);
  if (options.write && !options.stdout) {
    const outPath = resolve(options.out);
    writeFileSync(outPath, html, 'utf8');
    console.log(`\nwrote ${outPath}`);
  }
  if (options.json) {
    const jsonPath = resolve(options.json);
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`wrote ${jsonPath}`);
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
