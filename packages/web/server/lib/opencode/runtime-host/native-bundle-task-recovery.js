import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createManagedTaskScheduler, decodeLedgerSnapshot } from '@devryan/orchestration-runtime';
import { createAtomicManagedOrchestrationLedger } from '../../orchestration/atomic-ledger.js';
import { assertNoLiveOwner } from './native-bundle-startup-upgrade.js';
import { assertSelectedBundleLeasesSettled } from './native-bundle-lease-recovery.js';
import { captureRollbackRegistries } from './bundle-rollback-intent.js';
import { readRuntimeBundleBinding } from './runtime-bundle-binding.js';
import { readBundleJSON } from './bundle-migration-inventory.js';

const fail = () => Object.assign(Error('bundle_task_stop_unverified'), { code: 'bundle_task_stop_unverified', status: 503 });
const active = task => ['starting', 'running', 'cancelling'].includes(task.status);

// PID absence supplements this proof; it cannot replace the supervisor's
// acknowledgement that the entire confined controller group has terminated.
async function assertControllerReceipts(launch) {
  const root = path.join(path.dirname(path.dirname(launch.opencodeDatabasePath)), '.native-controller');
  if (await fs.realpath(root) !== root) throw fail();
  const instances = await fs.readdir(root, { withFileTypes: true });
  if (!instances.length || instances.length > 1024) throw fail();
  for (const instance of instances) {
    if (!instance.isDirectory() || !/^[a-f0-9-]{32,64}$/.test(instance.name)) throw fail();
    const file = path.join(root, instance.name, 'termination.json');
    if (await fs.realpath(file) !== file) throw fail();
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 1024) throw fail();
      const bytes = Buffer.alloc(1025);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 1024) throw fail();
      const receipt = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
      if (receipt.terminated !== true || receipt.confined !== true || !Number.isSafeInteger(receipt.exitCode) || receipt.exitCode < 0 || receipt.exitCode > 255
        || typeof receipt.cancelled !== 'boolean') throw fail();
    } finally { await handle.close(); }
  }
}

/** Inside bootstrap.lock, after native lease recovery, before strict bundle
 * verification. The temporary scheduler only loads and settles; it has no
 * provider transport and never activates queued work or recovery prompts. */
export async function recoverStoppedBundleManagedTasks({ controlRoot, launch, logger = console }) {
  let snapshot;
  try { snapshot = decodeLedgerSnapshot(await readBundleJSON(path.join(launch.webDataDirectory, 'orchestration', 'ledger.json')), { requireResultEnvelopes: false }); }
  catch (error) { if (error.code === 'ENOENT') return { status: 'clean' }; throw error; }
  if (!snapshot.tasks.some(active)) return { status: 'clean' };

  await assertNoLiveOwner(launch);
  const assertPhysicalStop = async () => {
    await assertControllerReceipts(launch);
    await captureRollbackRegistries(launch.global.state);
    await assertSelectedBundleLeasesSettled({ controlRoot });
  };
  await assertPhysicalStop();
  const ledger = createAtomicManagedOrchestrationLedger({ dataDirectory: launch.webDataDirectory, logger });
  let scheduler;
  try {
    await ledger.acquireOwnership();
    const assertStopped = async () => {
      await ledger.verifyOwnership();
      await assertPhysicalStop();
    };
    const noExecution = async () => { throw fail(); };
    scheduler = createManagedTaskScheduler({
      executor: { start: noExecution, resume: noExecution, reconcile: noExecution, observe: noExecution },
      persistence: {
        load: async () => { await assertStopped(); return ledger.load(); },
        save: async (value, observation) => { await assertStopped(); return ledger.save(value, observation); },
      },
      logger,
    });
    await scheduler.recoverStoppedRuntime(assertStopped);
    return { status: 'recovered' };
  } finally {
    try { await scheduler?.shutdown(); }
    finally { await ledger.releaseOwnership(); }
  }
}

export async function recoverSelectedBundleTasksAtStartup({ controlRoot, log = console }) {
  if (process.platform === 'win32') return { status: 'skipped' };
  try {
    const binding = readRuntimeBundleBinding({ DEVRYAN_RUNTIME_BUNDLE_ROOT: controlRoot }, { allowHeldInspection: true });
    if (binding.admission === 'held' || binding.selection.reconciliationRequired) return { status: 'held' };
    const result = await recoverStoppedBundleManagedTasks({ controlRoot, launch: binding.descriptor.launch, logger: log });
    if (result.status === 'recovered') log.info?.('[runtime-bundle] settled managed tasks after verified native termination');
    return result;
  } catch (error) {
    const code = /^[a-z][a-z0-9_]{1,100}$/.test(error?.code ?? '') ? error.code : 'bundle_task_stop_unverified';
    log.warn?.(`[runtime-bundle] managed task recovery refused: ${code}`);
    return { status: 'failed', code };
  }
}
