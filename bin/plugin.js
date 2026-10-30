#!/usr/bin/env node
/**
 * Cross-platform profile installer — the "how do others use it" entry point.
 *
 *   npx dsh-unwrapped install            # into $DSH_HOME/profiles/web
 *   npx dsh-unwrapped install --profile tui --language en
 *   npx dsh-unwrapped uninstall
 *   npx dsh-unwrapped status
 *
 * It copies the plugin into `<profile>/plugins/dsh-unwrapped` and keeps one
 * `rewind` insert row in `<profile>/cordis.patch.yml`, so a package manager is
 * never required. Running it from a checkout, a tarball, or an npm install all
 * behave the same, because it copies from its own package root.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hasRow, removeRow, upsertRow } from '../lib/profilePatch.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COPY_ENTRIES = ['index.js', 'package.json', 'README.md', 'lib', 'bin'];
const DEFAULT_DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');

const HELP = `dsh-unwrapped — install the conversation report into a DSH profile

Usage: dsh-unwrapped <command> [options]

Commands:
  install      copy the plugin into the profile and add its patch row
  uninstall    remove the patch row (and the copied files unless --keep-files)
  status       show whether the profile has the plugin installed
  patch        print the patch row without touching anything

Options:
  --profile <name>   profile to target (default: web)
  --home <dir>       DSH home (default: $DSH_HOME or ~/.dsh)
  --language <zh|en> report language (default: zh)
  --label <text>     launcher label (default: 年度回顾)
  --keep-files       uninstall: leave the copied plugin directory in place
  --dry-run          print what would change, write nothing
  -h, --help         show this help
`;

function parseArgs(argv) {
  const options = {
    command: 'install',
    profile: 'web',
    home: DEFAULT_DSH_HOME,
    language: 'zh',
    label: '年度回顾',
    keepFiles: false,
    dryRun: false,
    help: false,
  };
  const rest = [...argv];
  if (rest[0] && !rest[0].startsWith('-')) options.command = rest.shift();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const next = () => rest[++i];
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '--profile':
        options.profile = next();
        break;
      case '--home':
        options.home = next();
        break;
      case '--language':
        options.language = next();
        break;
      case '--label':
        options.label = next();
        break;
      case '--keep-files':
        options.keepFiles = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  return options;
}

function pathsFor(options) {
  const profileDir = join(options.home, 'profiles', options.profile);
  return {
    profileDir,
    pluginDir: join(profileDir, 'plugins', 'dsh-unwrapped'),
    patchFile: join(profileDir, 'cordis.patch.yml'),
  };
}

function readPatch(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function writePatch(file, text, dryRun) {
  if (dryRun) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
}

function copyPlugin(pluginDir, dryRun) {
  if (dryRun) return COPY_ENTRIES;
  mkdirSync(pluginDir, { recursive: true });
  // Mirror, don't merge: a stale docs/ or test/ from an older install would
  // otherwise linger forever inside the profile.
  for (const entry of readdirSync(pluginDir)) {
    if (!COPY_ENTRIES.includes(entry)) rmSync(join(pluginDir, entry), { recursive: true, force: true });
  }
  for (const entry of COPY_ENTRIES) {
    const from = join(PACKAGE_ROOT, entry);
    if (!existsSync(from)) continue;
    cpSync(from, join(pluginDir, entry), { recursive: true, force: true });
  }
  return COPY_ENTRIES;
}

function report(profileDir) {
  const packageFile = join(profileDir, 'package.json');
  if (!existsSync(packageFile)) return null;
  try {
    // Windows editors love a BOM; JSON.parse rejects it.
    return JSON.parse(readFileSync(packageFile, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function install(options) {
  const { profileDir, pluginDir, patchFile } = pathsFor(options);
  if (!existsSync(profileDir)) {
    throw new Error(`profile not found: ${profileDir}\nstart the harness once with: dsh --profile ${options.profile}`);
  }
  const meta = report(profileDir);
  const live = meta?.dsh?.profile?.patchReload === 'live';
  const copied = copyPlugin(pluginDir, options.dryRun);
  const patch = readPatch(patchFile);
  const next = upsertRow(patch, { language: options.language, label: options.label });
  const changed = next !== patch;
  if (changed) writePatch(patchFile, next, options.dryRun);

  console.log(`${options.dryRun ? 'would install' : 'installed'} ${copied.join(', ')}`);
  console.log(`  plugin -> ${pluginDir}`);
  console.log(`  patch  -> ${patchFile}${changed ? '' : ' (already up to date)'}`);
  if (live) console.log('  reload -> patchReload is live, refresh the GUI or open /unwrapped');
  else console.log(`  reload -> restart the harness (dsh --profile ${options.profile}) to pick it up`);
  return 0;
}

function uninstall(options) {
  const { pluginDir, patchFile } = pathsFor(options);
  const patch = readPatch(patchFile);
  if (!patch && !existsSync(pluginDir)) {
    console.log('nothing to uninstall');
    return 0;
  }
  if (patch && hasRow(patch)) {
    writePatch(patchFile, removeRow(patch), options.dryRun);
    console.log(`${options.dryRun ? 'would remove' : 'removed'} rewind row from ${patchFile}`);
  } else {
    console.log(`no rewind row in ${patchFile}`);
  }
  if (!options.keepFiles && existsSync(pluginDir)) {
    if (!options.dryRun) rmSync(pluginDir, { recursive: true, force: true });
    console.log(`${options.dryRun ? 'would remove' : 'removed'} ${pluginDir}`);
  }
  return 0;
}

function status(options) {
  const { profileDir, pluginDir, patchFile } = pathsFor(options);
  const exists = existsSync(profileDir);
  const installed = existsSync(join(pluginDir, 'index.js'));
  const patched = hasRow(readPatch(patchFile));
  const meta = exists ? report(profileDir) : null;
  console.log(`profile   ${profileDir}${exists ? '' : ' (missing)'}`);
  console.log(`files     ${installed ? 'present' : 'absent'}  ${pluginDir}`);
  console.log(`patch     ${patched ? 'present' : 'absent'}  ${patchFile}`);
  console.log(`reload    ${meta?.dsh?.profile?.patchReload || 'default'}`);
  const files = installed ? readdirSync(pluginDir) : [];
  if (files.length) console.log(`contents  ${files.join(', ')}`);
  return patched && installed ? 0 : 1;
}

function patchOnly(options) {
  process.stdout.write(upsertRow('', { language: options.language, label: options.label }));
  return 0;
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    console.error(`error: ${err.message}\n`);
    process.stderr.write(HELP);
    return 2;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  try {
    switch (options.command) {
      case 'install':
        return install(options);
      case 'uninstall':
        return uninstall(options);
      case 'status':
        return status(options);
      case 'patch':
        return patchOnly(options);
      default:
        console.error(`error: unknown command: ${options.command}\n`);
        process.stderr.write(HELP);
        return 2;
    }
  } catch (err) {
    console.error(`error: ${err.message}`);
    return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
