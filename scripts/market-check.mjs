#!/usr/bin/env node
/**
 * Market check for the npm side of a DSH plugin release:
 *
 *   node scripts/market-check.mjs                    # default candidate names
 *   node scripts/market-check.mjs --name foo --name bar
 *
 * 1. name availability (`GET /<name>` against the registry)
 * 2. who already publishes something similar in the `dsh-plugin` keyword space
 *
 * The search endpoint is the registry one (`/-/v1/search`), not the chat
 * provider's web search — no API key, no rate-limit surprises.
 */

const CANDIDATES = [
  'dsh-unwrapped',
  'dsh-unwrapped',
  'dsh-unwrapped',
  'dsh-plugin-conversation-rewind',
  'dsh-conversation-rewind',
  'dsh-plugin-year-in-review',
  'dsh-unwrapped-report',
  'dsh-unwrapped',
];

const SIMILAR = ['rewind', 'wrapped', 'year in review', '年度报告', '回顾', 'usage stats', 'session stats'];

const args = process.argv.slice(2);
const names = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--name' && args[i + 1]) names.push(args[++i]);
}
const targets = names.length ? names : CANDIDATES;

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

function describe(doc) {
  const pkg = doc.package;
  return [
    pkg.name.padEnd(38),
    (pkg.version || '').padEnd(10),
    (pkg.date || '').slice(0, 10),
    `dl/mo ${String(doc.downloads?.monthly ?? '?').padStart(7)}`,
    (pkg.description || '').replace(/\s+/g, ' ').slice(0, 96),
  ].join('  ');
}

console.log('== name availability ==');
for (const name of targets) {
  const doc = await getJson(`https://registry.npmjs.org/${encodeURIComponent(name).replace('%40', '@')}`);
  if (!doc) {
    console.log(`${name.padEnd(38)}  FREE`);
    continue;
  }
  const latest = doc['dist-tags']?.latest;
  const versions = Object.keys(doc.versions || {});
  const size = doc.versions?.[latest]?.dist?.unpackedSize;
  const description = doc.versions?.[latest]?.description || doc.description || '';
  console.log(`${name.padEnd(38)}  TAKEN  v${latest}  ${versions.length} version(s)  ${size ?? '?'}B unpacked  by ${(doc.maintainers || []).map((m) => m.name).join(',') || '?'}`);
  console.log(`${''.padEnd(40)}created ${(doc.time?.created || '').slice(0, 10)}  ${description.replace(/\s+/g, ' ').slice(0, 90)}`);
}

console.log('\n== similar packages (registry search) ==');
const seen = new Map();
for (const term of SIMILAR) {
  const data = await getJson(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(term)}&size=60`);
  for (const doc of data?.objects || []) {
    const pkg = doc.package;
    if (seen.has(pkg.name)) continue;
    const haystack = `${pkg.name} ${pkg.description || ''} ${(pkg.keywords || []).join(' ')}`.toLowerCase();
    if (!haystack.includes('dsh') && !haystack.includes('deepseek')) continue;
    seen.set(pkg.name, doc);
  }
}
const rows = [...seen.values()].sort((a, b) => (b.downloads?.monthly || 0) - (a.downloads?.monthly || 0));
for (const doc of rows.slice(0, 40)) console.log(describe(doc));
console.log(`\n${rows.length} dsh/deepseek-related hits across ${SIMILAR.length} queries`);
