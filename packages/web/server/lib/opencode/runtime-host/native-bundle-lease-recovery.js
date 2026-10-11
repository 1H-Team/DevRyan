import fs from 'node:fs/promises';
import path from 'node:path';
import { createSessionMutationRuntime } from '@openchamber/harness-runtime';
import { openChangeStore } from '../../../../../harness-runtime/lib/session-changes-store.js';
import { neverSpawnedControlLease, recoverExecutionLeases } from '../execution-preparations.js';
import { readRuntimeBundleBinding } from './runtime-bundle-binding.js';
import { assertNoLiveOwner } from './native-bundle-startup-upgrade.js';
import { containsPath } from './bundle-migration-inventory.js';
import { timeStartupPhase } from '../startup-timing.js';

const finiteCode = error => /^[a-z][a-z0-9_]{1,100}$/.test(error?.code ?? '') ? error.code : 'bundle_lease_recovery_failed';
const unsettled = lease => !['published', 'cancelled'].includes(lease?.state) || lease.cleanupPending;

/** Ledgers holding an unsettled control lease. Read only. Cleanup removes the
 * lease's view, so only a view inside the ledger's own views/ qualifies. */
const candidateLedgers = async storage => {
  let names;
  try { names = await fs.readdir(storage, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const ledgers = [];
  for (const entry of names) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const root = path.join(storage, entry.name), db = await openChangeStore(root, path.join(root, 'git'));
    if (!db.exists) continue;
    // Ledger recovery would replay a pending materialization into the project;
    // that stays with the started runtime, and the startup gate refuses it.
    if (await db.get('materialization.json')) return [];
    const meta = await db.get('meta.json');
    if (meta?.version !== 1 || !path.isAbsolute(meta.directory ?? '')) continue;
    const abandoned = lease => neverSpawnedControlLease(lease) && typeof lease.viewDirectory === 'string'
      && path.resolve(lease.viewDirectory) === lease.viewDirectory && containsPath(path.join(root, 'views'), lease.viewDirectory) && lease.viewDirectory !== path.join(root, 'views');
    for await (const { value } of db.entries('leases')) {
      if (unsettled(value) && abandoned(value)) { ledgers.push({ directory: meta.directory, abandoned }); break; }
    }
  }
  return ledgers;
};

/** Settles the abandoned control leases of one bundle's web data. The caller
 * guarantees that no live process owns the bundle. */
export async function recoverAbandonedControlLeases({ launch, createRuntime = createSessionMutationRuntime,
  assertOwnerAbsent = assertNoLiveOwner }) {
  const storage = path.join(launch.webDataDirectory, 'harness', 'session-mutations');
  const ledgers = await candidateLedgers(storage);
  if (!ledgers.length) return { status: 'clean' };
  return timeStartupPhase('bundle_lease_recovery', async () => {
    await assertOwnerAbsent(launch);
    const runtime = createRuntime({ directory: storage }), failures = [];
    try {
      for (const { directory, abandoned } of ledgers) {
        await recoverExecutionLeases({ runtime, directory, ownerLost: async lease => abandoned(lease),
          onFailure: cause => failures.push(finiteCode(cause)) });
      }
    } finally { await runtime.drain?.(); }
    if (!(await candidateLedgers(storage)).length) return { status: 'recovered' };
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
