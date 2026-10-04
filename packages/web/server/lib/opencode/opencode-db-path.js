import fs from 'node:fs';
import path from 'node:path';

// OpenCode names its database after its release channel. The bundled
// companion is built on the `devryan` channel and writes
// `opencode-devryan.db`; a plain OpenCode binary writes `opencode.db`. Both
// can exist in one data directory after switching runtimes.
export const OPENCODE_DB_FILE_NAME = 'opencode.db';
export const COMPANION_OPENCODE_DB_FILE_NAME = 'opencode-devryan.db';
export const OPENCODE_DB_FILE_NAMES = Object.freeze([COMPANION_OPENCODE_DB_FILE_NAME, OPENCODE_DB_FILE_NAME]);

/**
 * Legacy guess at the database the runtime is writing: of the known names that
 * exist, the one modified last (its write-ahead log counts, because SQLite may
 * not have checkpointed yet). Without any, the plain name, as before.
 *
 * Storage code uses the runtime selection manifest (`runtime-selection.js`);
 * this is its fallback for data directories that predate the manifest, allowed
 * for read-only inspection only. It cannot tell a v2 `opencode.db` apart.
 */
export const resolveOpenCodeDbPath = (dataPath, { statSync = fs.statSync } = {}) => {
  const modified = (file) => {
    try { return statSync(file).mtimeMs; } catch { return null; }
  };
  let selected = null;
  for (const name of OPENCODE_DB_FILE_NAMES) {
    const file = path.join(dataPath, name);
    const at = modified(file);
    if (at === null) continue;
    const latest = Math.max(at, modified(`${file}-wal`) ?? 0);
    if (!selected || latest > selected.latest) selected = { file, latest };
  }
  return selected?.file ?? path.join(dataPath, OPENCODE_DB_FILE_NAME);
};
