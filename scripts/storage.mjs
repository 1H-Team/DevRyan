#!/usr/bin/env node
// `.cache/` housekeeping.
//   bun run cache:report            size each `.cache` family
//   bun run cache:prune             preview what `clean` deletes
//   bun run cache:prune -- --apply  delete it
// Disposable: every family except the kept build caches (KEPT_CACHE_FAMILIES in
// cache-guard.mjs), plus `sessions/*` older than 14 days. A run directory pinned in
// run.json or storage-retention.json (the reusable live-provider QA profile) and
// anything modified in the last hour are kept.
// Symlinks are never followed; git worktrees under `worktrees/` are never touched.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { KEPT_CACHE_FAMILIES } from './cache-guard.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
const HOUR = 3_600_000;
const SESSION_AGE = 14 * 24 * HOUR;

export function isPinnedRun(directory) {
  return ['run.json', 'storage-retention.json'].some((name) => {
    try { return JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8')).pinned === true; } catch { return false; }
  });
}

// Kilobytes per child of `directory` (or of the entry itself), from one `du` call.
function childSizes(directory) {
  const result = spawnSync('du', ['-k', '-d', '1', directory], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const sizes = new Map();
  for (const line of result.stdout?.split('\n') ?? []) {
    const [kb, file] = line.split('\t');
    if (file) sizes.set(file, Number(kb) * 1024);
  }
  return sizes;
}

const entries = (directory) => {
  try { return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return []; }
};

/** Every `.cache` family with its size, and the units `clean` would delete. */
export function auditCache(root = repository, { now = Date.now() } = {}) {
  const cache = path.join(root, '.cache');
  const families = [], removals = [], kept = [];
  const sizes = childSizes(cache);
  for (const family of entries(cache)) {
    const absolute = path.join(cache, family.name);
    const relative = `.cache/${family.name}`;
    const bytes = sizes.get(absolute) ?? 0;
    const keep = KEPT_CACHE_FAMILIES.includes(family.name) && family.name !== 'sessions';
    families.push({ path: relative, bytes, kept: keep || family.isSymbolicLink() });
    if (keep || family.isSymbolicLink()) continue;
    if (!family.isDirectory()) {
      const recent = now - fs.lstatSync(absolute).mtimeMs < HOUR;
      (recent ? kept : removals).push({ path: relative, bytes, ...(recent ? { reason: 'modified in the last hour' } : {}) });
      continue;
    }
    const childBytes = childSizes(absolute);
    for (const child of entries(absolute)) {
      const target = path.join(absolute, child.name);
      const unit = { path: `${relative}/${child.name}`, bytes: childBytes.get(target) ?? 0 };
      const age = now - fs.lstatSync(target).mtimeMs;
      if (child.isSymbolicLink()) kept.push({ ...unit, reason: 'symlink' });
      else if (age < HOUR) kept.push({ ...unit, reason: 'modified in the last hour' });
      else if (family.name === 'sessions' && age < SESSION_AGE) kept.push({ ...unit, reason: 'session notes younger than 14 days' });
      else if (child.isDirectory() && isPinnedRun(target)) kept.push({ ...unit, reason: 'pinned run' });
      else removals.push(unit);
    }
  }
  const total = (rows) => rows.reduce((sum, row) => sum + row.bytes, 0);
  return { families, removals, kept, totalBytes: total(families), reclaimableBytes: total(removals) };
}

export function applyRemovals(root, removals) {
  const cache = path.join(root, '.cache');
  for (const { path: relative } of removals) {
    const target = path.resolve(root, relative);
    if (!target.startsWith(cache + path.sep)) throw new Error(`Refusing to delete outside .cache: ${relative}`);
    fs.rmSync(target, { recursive: true, force: true });
  }
  // Remove family folders the clean emptied.
  for (const family of entries(cache)) {
    const absolute = path.join(cache, family.name);
    if (family.isDirectory() && !KEPT_CACHE_FAMILIES.includes(family.name) && entries(absolute).length === 0) fs.rmdirSync(absolute);
  }
}

const human = (bytes) => {
  for (const [unit, size] of [['GB', 2 ** 30], ['MB', 2 ** 20], ['KB', 2 ** 10]]) if (bytes >= size) return `${(bytes / size).toFixed(1)} ${unit}`;
  return `${bytes} B`;
};

export function storageMain(argv, root = repository, log = console.log) {
  const [command = 'report', ...flags] = argv;
  const known = new Set(['--apply', '--json']);
  const unknown = flags.filter((flag) => !known.has(flag));
  if (!['report', 'clean'].includes(command) || unknown.length || (flags.includes('--apply') && command !== 'clean')) {
    console.error('Usage: storage.mjs report [--json] | clean [--apply] [--json]');
    return 2;
  }
  const audit = auditCache(root);
  const apply = flags.includes('--apply');
  if (apply) applyRemovals(root, audit.removals);
  if (flags.includes('--json')) {
    log(JSON.stringify({ ...audit, applied: apply }, null, 2));
    return 0;
  }
  if (command === 'report') {
    log(`.cache total ${human(audit.totalBytes)}; reclaimable ${human(audit.reclaimableBytes)}`);
    for (const family of [...audit.families].sort((a, b) => b.bytes - a.bytes)) {
      log(`  ${human(family.bytes).padStart(9)}  ${family.path}${family.kept ? '  (kept)' : ''}`);
    }
    return 0;
  }
  log(`${apply ? 'Deleted' : 'Would delete'} ${audit.removals.length} entries, ${human(audit.reclaimableBytes)} of ${human(audit.totalBytes)} in .cache.`);
  for (const row of [...audit.removals].sort((a, b) => b.bytes - a.bytes).slice(0, 15)) log(`  ${human(row.bytes).padStart(9)}  ${row.path}`);
  if (audit.removals.length > 15) log(`  … and ${audit.removals.length - 15} more`);
  if (audit.kept.length) log(`Kept ${audit.kept.length} entries (recent, pinned, symlinks or young session notes).`);
  if (!apply && audit.removals.length) log('Run `bun run cache:prune -- --apply` to delete them.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = storageMain(process.argv.slice(2));
}
