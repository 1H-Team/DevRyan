// Fails a validation run that leaves new scratch in the repository's `.cache/`.
// Tests and QA put disposable files in the OS temp dir and delete them; only the
// build caches below may grow. The snapshot is two directory levels of names
// (readdir only), so it stays cheap even when `.cache/` is large.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Build and tool caches that are kept and may change during a run. */
export const KEPT_CACHE_FAMILIES = Object.freeze([
  'eslint', 'typecheck', 'shared', 'worktrees', 'sessions',
  'session-execution', 'windows-native', 'revert-runtime-companion',
]);

const list = (directory) => {
  try { return fs.readdirSync(directory, { withFileTypes: true }); } catch { return []; }
};

/** True when a directory holds no files at any depth (only empty folders). */
function isEmptyTree(directory) {
  return list(directory).every((entry) => entry.isDirectory() && isEmptyTree(path.join(directory, entry.name)));
}

export function snapshotCache(root) {
  const cache = path.join(root, '.cache');
  const entries = new Set();
  for (const entry of list(cache)) {
    if (KEPT_CACHE_FAMILIES.includes(entry.name)) continue;
    if (!entry.isDirectory()) { entries.add(entry.name); continue; }
    // Empty folders left by a cleaned-up run are not scratch.
    const children = list(path.join(cache, entry.name)).filter((child) => !(child.isDirectory() && isEmptyTree(path.join(cache, entry.name, child.name))));
    if (children.length) entries.add(entry.name);
    for (const child of children) entries.add(`${entry.name}/${child.name}`);
  }
  return entries;
}

/** Entries present after but not before; children of a new top-level folder are reported as that folder. */
export function newCacheEntries(before, after) {
  const added = [...after].filter((entry) => !before.has(entry));
  const addedTop = new Set(added.filter((entry) => !entry.includes('/')));
  return added.filter((entry) => !entry.includes('/') || !addedTop.has(entry.split('/')[0])).sort();
}

/** Files inside a new entry, so the report names the producer's output, not just its folder. */
function filesUnder(target) {
  const found = [];
  const walk = (directory) => {
    for (const entry of list(directory)) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(child);
      else found.push(child);
      if (found.length >= 10) return;
    }
  };
  if (list(target).length) walk(target);
  return found;
}

function size(file) {
  const result = spawnSync('du', ['-sh', file], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.split('\t')[0] : '?';
}

/** Returns a failure message naming the new entries, or null when `.cache/` gained nothing. */
export function cacheGrowthFailure(root, before) {
  const added = newCacheEntries(before, snapshotCache(root));
  if (added.length === 0) return null;
  const shown = added.slice(0, 20).flatMap((entry) => [`- .cache/${entry} (${size(path.join(root, '.cache', entry))})`,
    ...filesUnder(path.join(root, '.cache', entry)).slice(0, 10).map((file) => `    ${path.relative(path.join(root, '.cache'), file)}`)]);
  return [
    `This run left ${added.length} new entr${added.length === 1 ? 'y' : 'ies'} in .cache/:`,
    ...shown,
    ...(added.length > shown.length ? [`- … and ${added.length - shown.length} more`] : []),
    'Tests and QA must use the OS temp dir and delete their scratch (see docs/TESTING.md).',
    'If another process wrote these at the same time, re-run once it is idle.',
  ].join('\n');
}
