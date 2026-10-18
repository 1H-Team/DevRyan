import path from 'node:path';

const absolute = value => {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value || /[\u0000-\u001f]/.test(value)) {
    throw Object.assign(new Error('bundle_recovery_owner_required'), { code: 'bundle_recovery_owner_required' });
  }
  return value;
};

/** One root for CLI, provisioning and shell inspection; no filesystem access. */
export function resolveRuntimeBundleRoot(environment, home) {
  if (environment.DEVRYAN_RUNTIME_BUNDLE_ROOT !== undefined) return absolute(environment.DEVRYAN_RUNTIME_BUNDLE_ROOT);
  const state = absolute(environment.XDG_STATE_HOME || path.join(absolute(home), '.local', 'state'));
  return path.join(state, 'devryan', 'runtime-bundles');
}

/** The existing selection the shell may inspect, or null when none exists. It
 * starts nothing and grants no admission; the reader is injected so a shell can
 * resolve the root before it loads the binding module. */
export function readNativeShellBundleBinding({ environment, home, existsSync, readRuntimeBundleBinding }) {
  const controlRoot = resolveRuntimeBundleRoot(environment, home);
  return existsSync(path.join(controlRoot, 'selection.json'))
    ? readRuntimeBundleBinding({ DEVRYAN_RUNTIME_BUNDLE_ROOT: controlRoot }, { allowHeldInspection: true }) : null;
}
