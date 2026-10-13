import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createSessionMutationRuntime } from '@openchamber/harness-runtime';
import { openChangeStore } from '../../../../../harness-runtime/lib/session-changes-store.js';
import { neverSpawnedControlLease, recoverExecutionLeases } from '../execution-preparations.js';
import { readRuntimeBundleBinding } from './runtime-bundle-binding.js';
import { assertNoLiveOwner } from './native-bundle-startup-upgrade.js';
import { containsPath } from './bundle-migration-inventory.js';
import { timeStartupPhase } from '../startup-timing.js';
import { executionHostOwnerLost } from '../../../../../harness-runtime/lib/execution-host-owner.js';
import { changeKey } from '../../../../../harness-runtime/lib/session-changes-store.js';
import { executionArtifacts } from '../execution-artifacts.js';
import { verifyNativeRuntimeArtifacts } from './native-artifacts.js';
import { git } from '../../../../../harness-runtime/lib/session-changes-git.js';
import { originalRebootLease, rebootRecoveryCanonical } from '../../../../../harness-runtime/lib/session-reboot-recovery.js';

const finiteCode = error => /^[a-z][a-z0-9_]{1,100}$/.test(error?.code ?? '') ? error.code : 'bundle_lease_recovery_failed';
// System errors (ENOENT, EACCES) name the missing evidence; keep them visible in the log.
const failureCode = error => /^E[A-Z0-9]{2,20}$/.test(error?.code ?? '') ? `bundle_lease_recovery_failed:${error.code}` : finiteCode(error);
const unsettled = lease => !['published', 'cancelled'].includes(lease?.state) || lease.cleanupPending;
const needsRecovery = lease => unsettled(lease) || ['published', 'cancelled'].includes(lease?.state) && !lease.cleaned;

/** Read-only preflight. A refusal here never replaces final bundle verification.
 * `allRecords` digests every ledger record into `inventorySha256`, the canonical
 * hash of `[{ directory, records: [{ key, value }], root }]`, without retaining
 * them: a ledger holds several records per project file. A lease this `intent`
 * already recovered is digested as its original. Only leases are returned. */
export async function readBundleLeaseInventory(launch, { allRecords = false, intent } = {}) {
  const storage = path.join(launch.webDataDirectory, 'harness', 'session-mutations');
  let names;
  try { names = await fs.readdir(storage, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const ledgers = [], inventory = createHash('sha256').update('[');
  for (const entry of names.sort((a, b) => a.name.localeCompare(b.name))) {
    // A stray entry is reported by the bundle verifier; it holds no leases.
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
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
    const records = []; let digested = 0, revertPending = false;
    inventory.update(`${ledgers.length ? ',' : ''}{"directory":${JSON.stringify(meta.directory)},"records":[`);
    for await (const row of allRecords ? db.records() : db.entries('leases')) {
      if (allRecords) {
        const value = row.value?.rebootRecovery?.fenceID === intent?.fenceID
          && intent?.leases.some(lease => lease.root === root && lease.key === row.key) ? originalRebootLease(row.value) : row.value;
        inventory.update(`${digested++ ? ',' : ''}${rebootRecoveryCanonical({ key: row.key, value })}`);
        revertPending ||= row.key.startsWith('transactions/') && row.value.state === 'prepared' || row.key.startsWith('sessions/') && Boolean(row.value.pending);
        if (!row.key.startsWith('leases/')) continue;
      }
      records.push(row);
    }
    inventory.update(`],"root":${JSON.stringify(root)}}`);
    if (revertPending) throw Object.assign(Error('migration_revert_pending'), { code: 'migration_revert_pending' });
    const leasePins = allRecords ? (await git(root, ['--git-dir', path.join(root, 'git'), 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/devryan/leases/']))
      .toString().trim().split('\n').filter(Boolean).map(line => { const [ref, oid] = line.split(' '); return { ref, oid }; }) : [];
    ledgers.push({ root, directory: meta.directory, records, leasePins, db });
  }
  return allRecords ? Object.assign(ledgers, { inventorySha256: inventory.update(']').digest('hex') }) : ledgers;
}

export async function assertSelectedBundleLeasesSettled({ controlRoot }) {
  const binding = readRuntimeBundleBinding({ DEVRYAN_RUNTIME_BUNDLE_ROOT: controlRoot }, { allowHeldInspection: true });
  for (const ledger of await readBundleLeaseInventory(binding.descriptor.launch)) {
    const held = ledger.records.filter(row => row.key.startsWith('leases/') && unsettled(row.value));
    // Identifiers only: enough to find the lease in the ledger, never its contents.
    if (held.length) throw Object.assign(Error('bundle_execution_unsettled'), { code: 'bundle_execution_unsettled',
      detail: { ledger: path.basename(ledger.root).slice(0, 12), leases: held.slice(0, 8).map(row => ({ token: String(row.value.token).slice(0, 36),
        state: String(row.value.state).slice(0, 16), kind: String(row.value.executionKind ?? 'unclaimed').slice(0, 16), cleanupPending: row.value.cleanupPending === true })) } });
  }
}

/** Controls need never-spawned authority; processes additionally need their
 * native owner probe and either a genuine supervisor receipt or the host's
 * no-launch attestation. An aged `ready` process lease with no receipt file
 * never reached its supervisor and is cancelled as unstarted; an empty or
 * invalid receipt stays held. */
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
        // Receipt rules are applied by lease settlement and cleanup themselves.
        await recoverExecutionLeases({ runtime, directory, launcher, settleNeverStarted: true, ownerLost: async lease => abandoned?.(lease)
          || lease.executionKind === 'process' && await ownerLost({ directory: path.join(launch.webDataDirectory, 'harness', 'execution-owners'), launcher, id: lease.ownerID }),
          onFailure: cause => failures.push(failureCode(cause)) });
      }
    } finally { await runtime.drain?.(); }
    if (!(await readBundleLeaseInventory(launch)).some(ledger => ledger.records.some(row => needsRecovery(row.value)))) return { status: 'recovered' };
    return { status: 'failed', code: [...new Set(failures)].join(',') || 'bundle_lease_recovery_incomplete' };
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
