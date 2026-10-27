import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const normalizeScope = (value) => {
  const normalized = String(value || 'dev')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'dev';
};

export const resolveDevDataDirectory = (options = {}) => {
  const env = options.env ?? process.env;
  const configured = typeof env.DEVRYAN_DATA_DIR === 'string'
    ? env.DEVRYAN_DATA_DIR.trim()
    : '';
  if (configured) return path.resolve(configured);

  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const checkoutId = crypto.createHash('sha256').update(repoRoot).digest('hex').slice(0, 16);
  const temporaryRoot = path.resolve(options.temporaryRoot ?? os.tmpdir());
  return path.join(
    temporaryRoot,
    'devryan-development',
    checkoutId,
    normalizeScope(options.scope),
  );
};

// The native runtime bundle root defaults to `$XDG_STATE_HOME/devryan/runtime-bundles`,
// which the installed app owns. A dev server that binds it takes the app's
// OpenCode controller (`native_process_owner_unsettled`), so dev launchers give
// it a private state home under the dev data directory. Overriding the state
// home rather than `DEVRYAN_RUNTIME_BUNDLE_ROOT` keeps first-run provisioning.
// The path is realpath-resolved because bundle roots refuse symlinked parents
// (macOS `os.tmpdir()` sits under the `/var` link). An explicit
// `DEVRYAN_RUNTIME_BUNDLE_ROOT` is left to the caller.
export const resolveDevRuntimeEnvironment = (options = {}) => {
  const env = options.env ?? process.env;
  if (typeof env.DEVRYAN_RUNTIME_BUNDLE_ROOT === 'string' && env.DEVRYAN_RUNTIME_BUNDLE_ROOT.trim()) return {};
  const stateHome = path.join(path.resolve(options.devDataDirectory), 'xdg-state');
  fs.mkdirSync(stateHome, { recursive: true, mode: 0o700 });
  return { XDG_STATE_HOME: fs.realpathSync(stateHome) };
};
