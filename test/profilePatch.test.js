import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { hasRow, upsertRow, removeRow, yamlScalar } from '../lib/profilePatch.js';

const TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`;

const OTHER_ROW = `- id: session-query-sqlite
  config:
    path: ':memory:'
`;

describe('profilePatch: upsert', () => {
  it('writes a single insert row into an empty file', () => {
    const next = upsertRow('', { language: 'zh', label: '年度回顾' });
    assert.match(next, /^- insert:$/m);
    assert.match(next, /^ {4}- id: rewind$/m);
    assert.match(next, /launcherLabel: 年度回顾/);
    assert.equal(next.includes('[]'), false);
    assert.equal(next.split('- insert:').length - 1, 1);
  });

  it('drops the template empty-array marker and keeps the comments', () => {
    const next = upsertRow(TEMPLATE, { language: 'zh', label: '年度回顾' });
    assert.equal(next.includes('\n[]'), false);
    assert.match(next, /^# Your patch layer/m);
    assert.match(next, /id: rewind/);
  });

  it('is idempotent', () => {
    const once = upsertRow(TEMPLATE, { language: 'zh' });
    const twice = upsertRow(once, { language: 'zh' });
    assert.equal(twice, once);
    assert.equal(twice.split('id: rewind').length - 1, 1);
  });

  it('replaces an existing row when the config changes', () => {
    const once = upsertRow('', { language: 'zh', label: '年度回顾' });
    const next = upsertRow(once, { language: 'en', label: 'Rewind' });
    assert.match(next, /language: en/);
    assert.match(next, /launcherLabel: Rewind/);
    assert.equal(next.includes('年度回顾'), false);
    assert.equal(next.split('id: rewind').length - 1, 1);
  });

  it('leaves unrelated rows untouched', () => {
    const next = upsertRow(`${OTHER_ROW}\n`, { language: 'zh' });
    assert.match(next, /- id: session-query-sqlite/);
    assert.match(next, /id: rewind/);
    assert.equal(next.indexOf('session-query-sqlite') < next.indexOf('rewind'), true);
  });

  it('removes our entry from a shared insert block and keeps the others', () => {
    const shared = `- insert:
    - id: other
      name: some-plugin
    - id: rewind
      name: ./plugins/dsh-plugin-wrapped/index.js
`;
    const next = upsertRow(shared, { language: 'zh' });
    assert.equal(next.includes('some-plugin'), true);
    assert.equal(next.split('id: rewind').length - 1, 1);
  });
});

describe('profilePatch: remove', () => {
  it('restores a comments-only file with an empty array', () => {
    const installed = upsertRow(TEMPLATE, { language: 'zh' });
    const next = removeRow(installed);
    assert.equal(hasRow(next), false);
    assert.match(next, /^# Your patch layer/m);
    assert.match(next, /^\[\]$/m);
  });

  it('keeps other rows in place', () => {
    const installed = upsertRow(`${OTHER_ROW}\n`, { language: 'zh' });
    const next = removeRow(installed);
    assert.equal(hasRow(next), false);
    assert.match(next, /session-query-sqlite/);
    assert.equal(next.includes('[]'), false);
  });

  it('is a no-op on a file without our row', () => {
    const next = removeRow(OTHER_ROW);
    assert.equal(next.trim(), OTHER_ROW.trim());
  });

  it('returns a valid empty array for an empty file', () => {
    assert.equal(removeRow('').trim(), '[]');
  });
});

describe('profilePatch: hasRow', () => {
  it('detects the row regardless of indentation width', () => {
    assert.equal(hasRow('- insert:\n    - id: rewind\n'), true);
    assert.equal(hasRow('- insert:\n  - id: rewind\n'), true);
    assert.equal(hasRow('- insert:\n    - id: another\n'), false);
    assert.equal(hasRow(''), false);
  });
});

describe('profilePatch: yamlScalar', () => {
  it('keeps readable plain scalars', () => {
    assert.equal(yamlScalar('zh'), 'zh');
    assert.equal(yamlScalar('年度回顾'), '年度回顾');
    assert.equal(yamlScalar('Conversation Rewind'), 'Conversation Rewind');
  });

  it('quotes values YAML would otherwise misread', () => {
    assert.equal(yamlScalar(''), "''");
    assert.equal(yamlScalar('a: b'), "'a: b'");
    assert.equal(yamlScalar('- x'), "'- x'");
    assert.equal(yamlScalar('#tag'), "'#tag'");
    // A plain scalar may contain an apostrophe that is not leading.
    assert.equal(yamlScalar("it's"), "it's");
  });
});
