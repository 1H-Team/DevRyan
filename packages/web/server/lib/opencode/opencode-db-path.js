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
 * The database the runtime is writing: of the known names that exist, the one
 * modified last (its write-ahead log counts, because SQLite may not have
 * checkpointed yet). Without any, the plain name, as before.
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
