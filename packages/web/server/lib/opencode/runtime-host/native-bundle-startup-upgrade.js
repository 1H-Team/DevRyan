import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createRuntimeBundleLifecycle, nativeUpgradeBundleID } from './runtime-bundle-lifecycle.js';
import { readRuntimeBundleBinding } from './runtime-bundle-binding.js';
import { recordStartupBundleUpgradeFailure } from './bundle-startup-upgrade-status.js';
import { isProcessRunning, readManagedOpenCodeRegistry, readProcessStartTime,
  reapOrphanedManagedOpenCodeProcesses } from '../managed-process-registry.js';
import { resolveQaTargetOpenCodeVersion } from '../version-policy.js';

const fail = code => Object.assign(new Error(code), { code, status: 503 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const finiteCode = error => /^bundle_[a-z0-9_]{1,100}$/.test(error?.code ?? '') ? error.code : 'bundle_startup_upgrade_failed';
const exists = async file => {
  try { await fs.lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false; throw error; }
};
const release = value => /^(\d+)\.(\d+)\.(\d+)(?:-|$)/.exec(value ?? '')?.slice(1).map(Number) ?? null;
const newer = (left, right) => {
  const a = release(left), b = release(right);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index];
  return false;
};

/** Reads only the version and digest that decide whether to attempt the
 * upgrade. The lifecycle verifies both artifact sets before using either. */
const readManifest = async file => {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) return null;
    const bytes = await fs.readFile(file), manifest = JSON.parse(bytes.toString('utf8'));
    return { version: typeof manifest?.opencodeVersion === 'string' ? manifest.opencodeVersion : null, sha256: hash(bytes) };
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
};

const registryOptions = launch => ({ registryPath: path.join(launch.global.state, 'managed-opencode-processes.json') });
const ownerAlive = record => {
  if (!isProcessRunning(record.ownerPid)) return false;
  const started = record.ownerStartTime ? readProcessStartTime(record.ownerPid) : null;
  return started === null || started === record.ownerStartTime;
};

/** No other process may own the source bundle: no live owner or controller in
 * its managed-process registry and no live holder of its orchestration lock. */
const assertNoLiveOwner = async launch => {
  for (const record of readManagedOpenCodeRegistry(registryOptions(launch))) {
    if (ownerAlive(record) || isProcessRunning(record.childPid)) throw fail('bundle_upgrade_owner_active');
  }
  let owner;
  try { owner = JSON.parse(await fs.readFile(path.join(launch.webDataDirectory, 'orchestration', 'owner.lock'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw fail('bundle_upgrade_owner_active'); }
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0 || isProcessRunning(owner.pid)) throw fail('bundle_upgrade_owner_active');
};

/** An attempt killed during its copy leaves this exact candidate without a
 * preparation seal, and the store refuses to reuse it. A candidate named for
 * the current revision is never selected, a rollback target or sealed. */
const sweepUnsealedCandidate = async (controlRoot, bundleID) => {
  const bundles = path.join(controlRoot, 'bundles'), root = path.join(bundles, bundleID);
  if (!await exists(root) || await exists(path.join(root, 'sources', 'preparation.json'))) return;
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(root) !== root) throw fail('bundle_path_invalid');
  // Never remove in place: an interrupted removal leaves only a sibling the next launch sweeps.
  const stale = path.join(bundles, `.stale-${randomBytes(8).toString('hex')}`);
  await fs.rename(root, stale);
  await fs.rm(stale, { recursive: true });
};

/** Cold upgrade of the selected bundle at startup, inside the bootstrap lock and
 * before any data owner, controller or admission exists. It runs only when the
 * selected OpenCode version misses this application's pin and the application
 * ships exactly the pinned version, and it never downgrades. The lifecycle
 * upgrade performs the verified clone, credential capture and selector CAS, and
 * keeps the previous bundle as the rollback target. A failure leaves the
 * selection unchanged and is recorded for the startup error, never thrown. */
export async function upgradeSelectedNativeBundleAtStartup({ controlRoot, env = process.env, artifactDirectory,
  verifyArtifacts, credentialProcess, privatePersistence = {}, createLifecycle = createRuntimeBundleLifecycle, log = console }) {
  const refused = code => {
    recordStartupBundleUpgradeFailure(code);
    log.warn?.(`[runtime-bundle] startup upgrade not applied: ${code}`);
    return { status: 'failed', code };
  };
  let expected;
  try { expected = resolveQaTargetOpenCodeVersion(env).version; } catch { return { status: 'skipped' }; }
  try {
    const binding = readRuntimeBundleBinding({ DEVRYAN_RUNTIME_BUNDLE_ROOT: controlRoot }, { allowHeldInspection: true });
    if (binding.admission === 'held' || binding.selection.reconciliationRequired) return { status: 'held' };
    const launch = binding.descriptor.launch;
    const selected = await readManifest(launch.artifactManifestPath);
    if (selected?.version === expected) return { status: 'current' };
    const shipped = await readManifest(path.join(artifactDirectory, 'native-bundle.json'));
    if (shipped?.version !== expected) return refused('bundle_upgrade_unavailable');
    if (newer(selected?.version, expected)) return refused('bundle_runtime_newer_than_application');
    // The next controller launch reaps dead owners' orphans anyway; a live owner is never touched.
    const reaped = await reapOrphanedManagedOpenCodeProcesses(registryOptions(launch));
    if (reaped.kept.length || reaped.reaped.some(entry => !entry.terminated)) throw fail('bundle_upgrade_owner_active');
    await assertNoLiveOwner(launch);
    await sweepUnsealedCandidate(controlRoot, nativeUpgradeBundleID(shipped.sha256, binding.selection.revision));
    const lifecycle = createLifecycle({ binding, neverStarted: true, getController: () => null,
      closeAdmission: async () => {}, assertAdmissionClosed: () => assertNoLiveOwner(launch),
      stopProducers: async () => {}, drainStores: async () => {}, executionHost: { drain: async () => {} },
      artifactDirectory, verifyArtifacts, credentialProcess, privatePersistence });
    const result = await lifecycle.upgrade({ expectedRevision: binding.selection.revision });
    log.info?.(`[runtime-bundle] upgraded the selected runtime from OpenCode ${selected?.version ?? 'unknown'} to ${shipped.version}`);
    return { status: 'upgraded', revision: result.revision, from: selected?.version ?? null, to: shipped.version };
  } catch (error) {
    return refused(finiteCode(error));
  }
}
