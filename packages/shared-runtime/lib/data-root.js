// Node-only. The DevRyan data root is ~/.config/devryan; ~/.config/openchamber
// is the pre-rename location. The one-time move lives in
// packages/harness-runtime/lib/data-root-migration.js.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readDevRyanEnv } from './legacy-environment.js';

export const DATA_ROOT_NAME = 'devryan';
export const LEGACY_DATA_ROOT_NAME = 'openchamber';

/** The default location and its pre-rename sibling under `<home>/.config`. */
export function defaultDataRootPaths(home = os.homedir()) {
  const config = path.join(home, '.config');
  return Object.freeze({ root: path.join(config, DATA_ROOT_NAME), legacy: path.join(config, LEGACY_DATA_ROOT_NAME) });
}

/**
 * The configured data root, or null for the default. A configured value equal to
 * either default location counts as the default, so a relaunch that pins the
 * legacy path still follows the migration.
 */
export function explicitDataRoot(env = process.env, home = os.homedir()) {
  const value = readDevRyanEnv(env, 'DEVRYAN_DATA_DIR');
  if (typeof value !== 'string' || !value.trim()) return null;
  const resolved = path.resolve(value.trim());
  const { root, legacy } = defaultDataRootPaths(home);
  return resolved === root || resolved === legacy ? null : resolved;
}

const realpathOrNull = (target, realpathSync) => {
  try { return realpathSync(target); } catch { return null; }
};

/**
 * True while the legacy location still holds the data itself: a real directory,
 * or a link that does not resolve to the DevRyan root (for example a user's link
 * to another volume). After migration it is a link to the root.
 */
export function isLegacyDataRootInPlace(home = os.homedir(), { lstatSync = fs.lstatSync, realpathSync = fs.realpathSync } = {}) {
  const { root, legacy } = defaultDataRootPaths(home);
  let stat;
  try { stat = lstatSync(legacy); } catch { return false; }
  if (stat.isDirectory()) return true;
  if (!stat.isSymbolicLink()) return false;
  const target = realpathOrNull(legacy, realpathSync);
  if (target === null) return false;
  return target !== realpathOrNull(root, realpathSync);
}

/**
 * The data root every DevRyan process uses: the configured root, else the legacy
 * location while it still holds the data (migration deferred or impossible),
 * else ~/.config/devryan.
 */
export function resolveDevRyanDataRoot({ env = process.env, home = os.homedir(), lstatSync, realpathSync } = {}) {
  const explicit = explicitDataRoot(env, home);
  if (explicit) return explicit;
  const { root, legacy } = defaultDataRootPaths(home);
  return isLegacyDataRootInPlace(home, { lstatSync, realpathSync }) ? legacy : root;
}
