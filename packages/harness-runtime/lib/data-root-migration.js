// One-time move of ~/.config/openchamber to ~/.config/devryan, leaving a
// compatibility link at the old path. Both folders share a parent, so the move
// is one rename(2); nothing is copied. Every step is idempotent: an interrupted
// run is finished by the next start.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DATA_ROOT_NAME, defaultDataRootPaths, explicitDataRoot,
} from '@openchamber/shared-runtime/node/data-root.js';
import { withCrossProcessFileLock, writeFileAtomic } from './atomic-file.js';

export const DATA_ROOT_MIGRATION_MARKER = '.devryan-migration.json';
const MARKER_SCHEMA = 1;
const CONFLICT_PREFIX = 'legacy-openchamber-';
// The old folder cannot be renamed in place: a bind mount (Docker), another
// volume behind a user link, or a read-only filesystem. It stays in use.
const IN_PLACE_CODES = new Set(['EXDEV', 'EBUSY', 'EPERM', 'EACCES', 'EROFS', 'ENOTSUP']);

const isMissing = error => error?.code === 'ENOENT';

const lstatOrNull = async (fsApi, target) => {
  try { return await fsApi.lstat(target); } catch (error) { if (isMissing(error)) return null; throw error; }
};
const realpathOrNull = async (fsApi, target) => {
  try { return await fsApi.realpath(target); } catch (error) { if (isMissing(error)) return null; throw error; }
};

const readMarker = async (fsApi, directory) => {
  try {
    const parsed = JSON.parse(await fsApi.readFile(path.join(directory, DATA_ROOT_MIGRATION_MARKER), 'utf8'));
    return parsed?.schema === MARKER_SCHEMA ? parsed : null;
  } catch { return null; }
};

const writeMarker = (fsApi, directory, record) => writeFileAtomic(
  path.join(directory, DATA_ROOT_MIGRATION_MARKER), `${JSON.stringify({ schema: MARKER_SCHEMA, ...record })}\n`, { fs: fsApi, mode: 0o600 },
);

/** Classifies the legacy path relative to the DevRyan root. */
async function inspect(fsApi, root, legacy) {
  const [legacyStat, rootStat] = await Promise.all([lstatOrNull(fsApi, legacy), lstatOrNull(fsApi, root)]);
  let legacyState = 'absent';
  if (legacyStat?.isDirectory()) legacyState = 'directory';
  else if (legacyStat?.isSymbolicLink()) {
    const [target, rootTarget] = await Promise.all([realpathOrNull(fsApi, legacy), realpathOrNull(fsApi, root)]);
    legacyState = target !== null && target === rootTarget ? 'linked' : target === null ? 'dangling' : 'foreign-link';
  } else if (legacyStat) legacyState = 'other';
  return { legacyState, rootExists: Boolean(rootStat) };
}

const link = (fsApi, legacy) => fsApi.symlink(DATA_ROOT_NAME, legacy, 'dir');

/**
 * Moves legacy entries into an existing root; conflicts go to a dated folder.
 * A failed move is rolled back so the legacy folder stays complete and in use.
 */
async function mergeInto(fsApi, root, legacy, legacyState, now) {
  const conflicts = [], moved = [];
  let conflictDirectory = null;
  try {
    for (const name of await fsApi.readdir(legacy)) {
      if (name === DATA_ROOT_MIGRATION_MARKER) continue;
      let destination = path.join(root, name);
      if (await lstatOrNull(fsApi, destination)) {
        conflictDirectory ??= path.join(root, `${CONFLICT_PREFIX}${now().toISOString().replaceAll(':', '-')}`);
        await fsApi.mkdir(conflictDirectory, { recursive: true, mode: 0o700 });
        destination = path.join(conflictDirectory, name);
      }
      await fsApi.rename(path.join(legacy, name), destination);
      moved.push([path.join(legacy, name), destination]);
      if (destination !== path.join(root, name)) conflicts.push(name);
    }
  } catch (error) {
    for (const [source, destination] of moved.reverse()) await fsApi.rename(destination, source).catch(() => undefined);
    if (conflictDirectory) await fsApi.rmdir(conflictDirectory).catch(() => undefined);
    throw error;
  }
  await fsApi.rm(path.join(legacy, DATA_ROOT_MIGRATION_MARKER), { force: true });
  // A user's link to another folder is replaced; the folder it named stays.
  if (legacyState === 'foreign-link') await fsApi.unlink(legacy);
  else await fsApi.rmdir(legacy);
  return { conflicts, conflictDirectory };
}

/** Links the legacy path to the root. An older process that recreated the folder
 * between the rename and the link has its new entries merged first. */
async function linkLegacy(fsApi, root, legacy, now) {
  for (let attempt = 0; ; attempt += 1) {
    try { await link(fsApi, legacy); return null; } catch (error) {
      if (error?.code !== 'EEXIST' || attempt >= 2) throw error;
    }
    const state = await inspect(fsApi, root, legacy);
    if (state.legacyState === 'linked') return null;
    if (state.legacyState !== 'directory') throw Object.assign(new Error('data_root_legacy_path_occupied'), { code: 'EEXIST' });
    const merged = await mergeInto(fsApi, root, legacy, state.legacyState, now);
    if (merged.conflicts.length) return merged;
  }
}

/**
 * Runs the migration for the default data root. Outcomes:
 * explicit, unsupported_platform, none, current, linked, migrated, merged,
 * deferred (another start holds the lock), kept_in_place. Older DevRyan
 * processes may still run: they keep working through the link. Errors other
 * than the in-place codes propagate.
 */
export async function migrateLegacyDataRoot({
  env = process.env, home = os.homedir(), platform = process.platform, fs: fsApi = fs, now = () => new Date(),
  lockOptions = {},
} = {}) {
  if (platform === 'win32') return { outcome: 'unsupported_platform' };
  if (explicitDataRoot(env, home)) return { outcome: 'explicit' };
  const { root, legacy } = defaultDataRootPaths(home);
  const before = await inspect(fsApi, root, legacy);
  // Fast path without the lock: nothing to move, and no interrupted move to finish.
  if (before.legacyState === 'linked' || before.legacyState === 'other') return { outcome: 'current', root };
  if (before.legacyState === 'absent' && !before.rootExists) return { outcome: 'none', root };
  if (before.legacyState === 'absent' && (await readMarker(fsApi, root))?.state !== 'renamed') return { outcome: 'current', root };

  const stateHome = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(home, '.local', 'state');
  const lockPath = path.join(stateHome, DATA_ROOT_NAME, 'migrations', 'data-root.lock');
  return withCrossProcessFileLock(lockPath, async () => {
    const state = await inspect(fsApi, root, legacy);
    if (state.legacyState === 'linked' || state.legacyState === 'other') return { outcome: 'current', root };
    if (state.legacyState === 'absent' || state.legacyState === 'dangling') {
      const marker = state.rootExists ? await readMarker(fsApi, root) : null;
      if (marker?.state !== 'renamed') return { outcome: state.rootExists ? 'current' : 'none', root };
      // Interrupted after the rename: only the link and the marker are missing.
      if (state.legacyState === 'dangling') await fsApi.unlink(legacy);
      await link(fsApi, legacy);
      await writeMarker(fsApi, root, { ...marker, state: 'complete', completedAt: now().toISOString() });
      return { outcome: 'linked', root };
    }
    try {
      if (!state.rootExists) {
        const startedAt = now().toISOString();
        // Written before the rename and moved with it, so a crash before the link
        // is recognised and finished by the next start.
        await writeMarker(fsApi, legacy, { state: 'renamed', from: legacy, startedAt });
        await fsApi.rename(legacy, root);
        const raced = await linkLegacy(fsApi, root, legacy, now);
        await writeMarker(fsApi, root, { state: 'complete', from: legacy, startedAt, completedAt: now().toISOString() });
        return raced ? { outcome: 'merged', root, ...raced } : { outcome: 'migrated', root };
      }
      // Both exist: an older process recreated the folder, or a downgrade ran.
      const { conflicts, conflictDirectory } = await mergeInto(fsApi, root, legacy, state.legacyState, now);
      await linkLegacy(fsApi, root, legacy, now);
      await writeMarker(fsApi, root, { state: 'complete', from: legacy, merged: true, conflicts: conflicts.length, completedAt: now().toISOString() });
      return { outcome: 'merged', root, conflicts, conflictDirectory };
    } catch (error) {
      if (!IN_PLACE_CODES.has(error?.code)) throw error;
      return { outcome: 'kept_in_place', root: legacy, code: error.code };
    }
  }, { timeoutMs: 15_000, ...lockOptions }).catch(error => {
    // Another DevRyan process is migrating; it finishes, and this start reads
    // whichever root the resolver then finds.
    if (error?.code === 'LOCK_TIMEOUT') return { outcome: 'deferred' };
    throw error;
  });
}
