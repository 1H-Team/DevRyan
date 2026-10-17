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

export function snapshotCache(root) {
  const cache = path.join(root, '.cache');
  const entries = new Set();
  for (const entry of list(cache)) {
    if (KEPT_CACHE_FAMILIES.includes(entry.name)) continue;
    if (!entry.isDirectory()) { entries.add(entry.name); continue; }
    // Empty folders left by a cleaned-up run are not scratch.
    const children = list(path.join(cache, entry.name));
    if (children.length) entries.add(entry.name);
    for (const child of children) {
      const childPath = path.join(cache, entry.name, child.name);
      if (child.isDirectory() && list(childPath).length === 0) continue;
      entries.add(`${entry.name}/${child.name}`);
    }
  }
  return entries;
}

/** Entries present after but not before; children of a new top-level folder are reported as that folder. */
export function newCacheEntries(before, after) {
  const added = [...after].filter((entry) => !before.has(entry));
  const addedTop = new Set(added.filter((entry) => !entry.includes('/')));
  return added.filter((entry) => !entry.includes('/') || !addedTop.has(entry.split('/')[0])).sort();
}

function size(file) {
  const result = spawnSync('du', ['-sh', file], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.split('\t')[0] : '?';
}

/** Returns a failure message naming the new entries, or null when `.cache/` gained nothing. */
export function cacheGrowthFailure(root, before) {
  const added = newCacheEntries(before, snapshotCache(root));
  if (added.length === 0) return null;
  const shown = added.slice(0, 20).map((entry) => `- .cache/${entry} (${size(path.join(root, '.cache', entry))})`);
  return [
    `This run left ${added.length} new entr${added.length === 1 ? 'y' : 'ies'} in .cache/:`,
    ...shown,
    ...(added.length > shown.length ? [`- … and ${added.length - shown.length} more`] : []),
    'Tests and QA must use the OS temp dir and delete their scratch (see docs/TESTING.md).',
    'If another process wrote these at the same time, re-run once it is idle.',
  ].join('\n');
}
