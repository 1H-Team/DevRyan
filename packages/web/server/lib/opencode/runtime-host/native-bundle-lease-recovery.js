import fs from 'node:fs/promises';
import path from 'node:path';
import { createSessionMutationRuntime } from '@openchamber/harness-runtime';
import { openChangeStore } from '../../../../../harness-runtime/lib/session-changes-store.js';
import { neverSpawnedControlLease, recoverExecutionLeases } from '../execution-preparations.js';
import { readRuntimeBundleBinding } from './runtime-bundle-binding.js';
import { assertNoLiveOwner } from './native-bundle-startup-upgrade.js';
import { containsPath } from './bundle-migration-inventory.js';
import { timeStartupPhase } from '../startup-timing.js';
import { executionHostOwnerLost } from '../../../../../harness-runtime/lib/execution-host-owner.js';
import { readSessionExecutionReceipt } from '../../../../../harness-runtime/lib/session-execution.js';
import { changeKey } from '../../../../../harness-runtime/lib/session-changes-store.js';
import { executionArtifacts } from '../execution-artifacts.js';
import { verifyNativeRuntimeArtifacts } from './native-artifacts.js';
import { git } from '../../../../../harness-runtime/lib/session-changes-git.js';

const finiteCode = error => /^[a-z][a-z0-9_]{1,100}$/.test(error?.code ?? '') ? error.code : 'bundle_lease_recovery_failed';
const unsettled = lease => !['published', 'cancelled'].includes(lease?.state) || lease.cleanupPending;
const needsRecovery = lease => unsettled(lease) || ['published', 'cancelled'].includes(lease?.state) && !lease.cleaned;

/** Read-only preflight. A refusal here never replaces final bundle verification. */
export async function readBundleLeaseInventory(launch, { allRecords = false } = {}) {
  const storage = path.join(launch.webDataDirectory, 'harness', 'session-mutations');
  let names;
  try { names = await fs.readdir(storage, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const ledgers = [];
  for (const entry of names.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) throw Object.assign(Error('bundle_harness_layout_invalid'), { code: 'bundle_harness_layout_invalid' });
    const root = path.join(storage, entry.name);
    if (await fs.realpath(root) !== root) throw Object.assign(Error('bundle_path_invalid'), { code: 'bundle_path_invalid' });
    const gitDirectory = path.join(root, 'git'), gitStat = await fs.lstat(gitDirectory);
    if (!gitStat.isDirectory() || gitStat.isSymbolicLink() || await fs.realpath(gitDirectory) !== gitDirectory)
      throw Object.assign(Error('bundle_path_invalid'), { code: 'bundle_path_invalid' });
    const db = await openChangeStore(root, gitDirectory);
    if (!db.exists || await db.get('materialization.json')) throw Object.assign(Error('bundle_materialization_pending'), { code: 'bundle_materialization_pending' });
    const meta = await db.get('meta.json');
    if (meta?.version !== 1 || !path.isAbsolute(meta.directory ?? '') || changeKey(meta.directory) !== entry.name)
      throw Object.assign(Error('bundle_harness_layout_invalid'), { code: 'bundle_harness_layout_invalid' });
    const records = []; let recoveryBytes = 0;
    for await (const row of allRecords ? db.records() : db.entries('leases')) {
      if (allRecords && (records.length >= 32768 || (recoveryBytes += Buffer.byteLength(JSON.stringify(row))) > 64 * 1024 ** 2))
        throw Object.assign(Error('bundle_reboot_recovery_inventory_invalid'), { code: 'bundle_reboot_recovery_inventory_invalid' });
      records.push(row);
    }
    if (allRecords && records.some(row => row.key.startsWith('transactions/') && row.value.state === 'prepared'
      || row.key.startsWith('sessions/') && row.value.pending)) throw Object.assign(Error('migration_revert_pending'), { code: 'migration_revert_pending' });
    const leasePins = allRecords ? (await git(root, ['--git-dir', path.join(root, 'git'), 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/devryan/leases/']))
      .toString().trim().split('\n').filter(Boolean).map(line => { const [ref, oid] = line.split(' '); return { ref, oid }; }) : [];
    ledgers.push({ root, directory: meta.directory, records, leasePins, db });
  }
  return ledgers;
}

export async function assertSelectedBundleLeasesSettled({ controlRoot }) {
  const binding = readRuntimeBundleBinding({ DEVRYAN_RUNTIME_BUNDLE_ROOT: controlRoot }, { allowHeldInspection: true });
  for (const ledger of await readBundleLeaseInventory(binding.descriptor.launch))
    if (ledger.records.some(row => row.key.startsWith('leases/') && unsettled(row.value)))
      throw Object.assign(Error('bundle_execution_unsettled'), { code: 'bundle_execution_unsettled' });
}

/** Controls need never-spawned authority; processes additionally need their
 * native owner probe and genuine supervisor receipt. Missing proof stays held. */
export async function recoverAbandonedControlLeases({ launch, createRuntime = createSessionMutationRuntime,
  assertOwnerAbsent = assertNoLiveOwner, ownerLost = executionHostOwnerLost, verifyArtifacts = verifyNativeRuntimeArtifacts }) {
  const storage = path.join(launch.webDataDirectory, 'harness', 'session-mutations');
  const inventory = await readBundleLeaseInventory(launch);
  const processLedgers = inventory.filter(ledger => ledger.records.some(row => row.value.executionKind === 'process' && needsRecovery(row.value)));
  const ledgers = inventory.map(ledger => ({ ...ledger, abandoned: lease => neverSpawnedControlLease(lease)
    && typeof lease.viewDirectory === 'string' && path.resolve(lease.viewDirectory) === lease.viewDirectory
    && containsPath(path.join(ledger.root, 'views'), lease.viewDirectory) && lease.viewDirectory !== path.join(ledger.root, 'views') }))
    .filter(ledger => ledger.records.some(row => needsRecovery(row.value) && (ledger.abandoned(row.value) || row.value.executionKind === 'process')));
  if (!ledgers.length) return { status: 'clean' };
  return timeStartupPhase('bundle_lease_recovery', async () => {
    await assertOwnerAbsent(launch);
    const launcher = executionArtifacts(path.dirname(launch.artifactManifestPath ?? '')).launcher;
    if (processLedgers.length) {
      const verified = await verifyArtifacts({ manifestPath: launch.artifactManifestPath,
        manifestSha256: launch.artifactManifestSha256, launcher, purpose: 'bundle-source' });
      if (verified.controller !== launch.controllerBinary) throw Object.assign(Error('bundle_artifact_generation_mismatch'), { code: 'bundle_artifact_generation_mismatch' });
    }
    const runtime = createRuntime({ directory: storage }), failures = [];
    try {
      for (const { directory, abandoned } of ledgers) {
        await recoverExecutionLeases({ runtime, directory, launcher, ownerLost: async lease => {
          if (abandoned?.(lease)) return true;
          if (lease.executionKind !== 'process' || !await ownerLost({ directory: path.join(launch.webDataDirectory, 'harness', 'execution-owners'), launcher, id: lease.ownerID })) return false;
          await readSessionExecutionReceipt(lease, { launcher });
          return true;
        },
          onFailure: cause => failures.push(finiteCode(cause)) });
      }
    } finally { await runtime.drain?.(); }
    if (!(await readBundleLeaseInventory(launch)).some(ledger => ledger.records.some(row => needsRecovery(row.value)))) return { status: 'recovered' };
    return { status: 'failed', code: failures[0] ?? 'bundle_lease_recovery_incomplete' };
  });
}

/** Cold settlement of the selected bundle's abandoned control leases, inside the
 * bootstrap lock and before the startup upgrade and launch verification. Both
 * refuse any unsettled lease, while in-runtime recovery runs only after launch.
 * A control lease spawned no process, so with no live owner of the bundle it is
 * abandoned. Process leases keep their termination-receipt rules. Never throws:
 * an unsettled lease left behind still fails the strict startup gate. */
export async function recoverSelectedBundleLeasesAtStartup({ controlRoot, log = console, ...options }) {
  if (process.platform === 'win32') return { status: 'skipped' };
  let result;
  try {
    const binding = readRuntimeBundleBinding({ DEVRYAN_RUNTIME_BUNDLE_ROOT: controlRoot }, { allowHeldInspection: true });
    if (binding.admission === 'held' || binding.selection.reconciliationRequired) return { status: 'held' };
    result = await recoverAbandonedControlLeases({ ...options, launch: binding.descriptor.launch });
  } catch (error) {
    result = { status: 'failed', code: finiteCode(error) };
  }
  if (result.status === 'recovered') log.info?.('[runtime-bundle] settled abandoned control leases of the selected bundle');
  if (result.status === 'failed') log.warn?.(`[runtime-bundle] abandoned control leases not settled: ${result.code}`);
  return result;
}
