/**
 * The one piece of YAML surgery this package does: keep exactly one `rewind`
 * insert row in a profile's `cordis.patch.yml`, without a YAML dependency.
 *
 * The file is a top-level sequence of patch entries. Our row is a single-entry
 * `- insert:` block; other people's rows are preserved byte-for-byte, and a
 * stray `[]` document marker (the shipped template's "empty array" line) is
 * dropped because an empty flow sequence followed by a block entry is not
 * valid YAML.
 */

const ROW_ID = 'rewind';

/** Render a plain or single-quoted YAML scalar. */
function yamlScalar(value) {
  const text = String(value ?? '');
  if (text === '') return "''";
  // Plain style is safe without indicators, and keeps Chinese labels readable.
  if (!/^[\s\-?,[\]{}#&*!|>'"%@`]/.test(text) && !/[:#\n]|^\s|\s$/.test(text)) return text;
  return `'${text.replace(/'/g, "''")}'`;
}

/** Split a patch file into blocks, marking the `- insert:` blocks. */
function scanBlocks(lines) {
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (/^- insert:\s*$/.test(line)) {
      const start = index;
      index += 1;
      while (index < lines.length && /^\s+\S/.test(lines[index])) index += 1;
      blocks.push({ kind: 'insert', start, end: index, lines: lines.slice(start, index) });
      continue;
    }
    blocks.push({ kind: 'line', start: index, end: index + 1, lines: [line] });
    index += 1;
  }
  return blocks;
}

function blockHasRow(block) {
  return block.kind === 'insert' && block.lines.some((line) => /^\s*-\s*id:\s*rewind\s*$/.test(line));
}

function rowStarted(line) {
  return /^\s{4}-\s*id:/.test(line) || /^\s{2}-\s*id:/.test(line);
}

/** Drop our row from an insert block that also holds other rows. */
function stripRowFromBlock(block) {
  const lines = block.lines;
  const start = lines.findIndex((line) => /^\s*-\s*id:\s*rewind\s*$/.test(line));
  if (start < 0) return lines;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (rowStarted(lines[i])) { end = i; break; }
  }
  return [...lines.slice(0, start), ...lines.slice(end)];
}

function countSiblings(block) {
  return block.lines.filter((line) => rowStarted(line)).length;
}

function nonComment(lines) {
  return lines.filter((line) => line.trim() !== '' && !line.trim().startsWith('#'));
}

/** Does the patch text already contain a rewind row? */
function hasRow(text) {
  return scanBlocks(String(text ?? '').split(/\r?\n/)).some(blockHasRow);
}

/**
 * Return `text` with exactly one rewind insert row, placed last.
 * @param {string} text current patch file contents (may be empty)
 * @param {{ language?: string, label?: string }} options
 */
function upsertRow(text, options = {}) {
  const { language = 'zh', label = '年度回顾' } = options;
  const lines = String(text ?? '').split(/\r?\n/);
  const kept = [];
  for (const block of scanBlocks(lines)) {
    if (block.kind === 'line') {
      if (block.lines[0].trim() !== '[]') kept.push(block.lines[0]);
      continue;
    }
    if (!blockHasRow(block)) { kept.push(...block.lines); continue; }
    if (countSiblings(block) > 1) kept.push(...stripRowFromBlock(block));
  }
  const body = kept.join('\n').trimEnd();
  const row = [
    '- insert:',
    `    - id: ${ROW_ID}`,
    '      name: ./plugins/dsh-plugin-wrapped/index.js',
    '      config:',
    `        language: ${yamlScalar(language)}`,
    `        launcherLabel: ${yamlScalar(label)}`,
  ].join('\n');
  return body ? `${body}\n\n${row}\n` : `${row}\n`;
}

/** Return `text` without the rewind row; keeps other rows and stays valid YAML. */
function removeRow(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const kept = [];
  for (const block of scanBlocks(lines)) {
    if (block.kind === 'line') {
      if (block.lines[0].trim() !== '[]') kept.push(block.lines[0]);
      continue;
    }
    if (!blockHasRow(block)) { kept.push(...block.lines); continue; }
    if (countSiblings(block) > 1) kept.push(...stripRowFromBlock(block));
  }
  const trailing = kept.join('\n').replace(/\s+$/, '');
  const significant = nonComment(trailing.split('\n'));
  if (significant.length === 0) {
    const comments = trailing.split('\n').filter((line) => line.trim().startsWith('#')).join('\n');
    return comments ? `${comments}\n[]\n` : '[]\n';
  }
  return `${trailing}\n`;
}

export { ROW_ID, yamlScalar, hasRow, upsertRow, removeRow, scanBlocks };
