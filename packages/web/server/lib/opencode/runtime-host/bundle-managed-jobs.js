import path from 'node:path';
import { bundleFailure, hasMigrationTable, isRecord, readBundleJSON } from './bundle-migration-inventory.js';
import { hasNativeManagedSubagentJobs } from './native-managed-job-contract.js';
import { readBundleNativeJobProofs } from './bundle-native-job-proofs.js';

const terminal = new Set(['completed', 'failed', 'aborted', 'interrupted']);
const segmentStates = new Set(['reserved', 'prepared', 'accepted', 'uncertain', 'cancelled']);
const managedJobID = value => typeof value === 'string' && /^dvr_job_[a-f0-9]{32}$/.test(value);
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !value.includes('\0');
const invalid = () => { throw bundleFailure('bundle_managed_job_reference_invalid'); };

/** The job table has no foreign keys. Check its independent recovery identities
 * before a clone or executable switch can give those rows another owner. */
export async function verifyBundleManagedJobs({ db, webDataDirectory, targetManifest, windowsOwner }) {
  let ledger;
  try { ledger = await readBundleJSON(path.join(webDataDirectory, 'orchestration', 'ledger.json'), { windowsOwner }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (ledger !== undefined && (!isRecord(ledger) || !Array.isArray(ledger.tasks))) throw bundleFailure('bundle_task_ledger_invalid');
  // Released proofs beside the ledger bind job rows too. A shard copy of a task
  // the ledger still holds is superseded by the ledger record.
  const ledgerTaskIDs = new Set((ledger?.tasks ?? []).map(task => isRecord(task) ? task.taskId : undefined));
  const proofs = (await readBundleNativeJobProofs(webDataDirectory, file => readBundleJSON(file, { windowsOwner })))
    .flatMap(shard => shard.proofs.map(proof => proof.task)).filter(task => !ledgerTaskIDs.has(task.taskId));
  const tasks = [...(ledger?.tasks ?? []), ...proofs];
  const bound = new Map(), notifications = new Set(), messages = new Set();
  let pending = false;
  for (const task of tasks) {
    if (!isRecord(task)) invalid();
    if (task.executionBackend !== 'native-job') continue;
    if (!identity(task.taskId) || !identity(task.rootSessionId) || !identity(task.directory)
      || task.childSessionId !== null && task.childSessionId !== undefined && !identity(task.childSessionId)
      || task.nativeJobSegments !== undefined && !Array.isArray(task.nativeJobSegments)) invalid();
    if (!terminal.has(task.status)) pending = true;
    for (const segment of task.nativeJobSegments ?? []) {
      if (!isRecord(segment) || !managedJobID(segment.jobID) || !identity(segment.notificationID) || !identity(segment.messageID)
        || !segmentStates.has(segment.state) || segment.completion !== undefined && !['pending', 'done'].includes(segment.completion)
        || bound.has(segment.jobID) || notifications.has(segment.notificationID) || messages.has(segment.messageID)
        || !identity(task.childSessionId)) invalid();
      bound.set(segment.jobID, { task, segment }); notifications.add(segment.notificationID); messages.add(segment.messageID);
      if (db.all('SELECT id FROM session_message WHERE id=?', [segment.notificationID]).length
        || hasMigrationTable(db, 'session_inbox') && db.all('SELECT id FROM session_inbox WHERE id=?', [segment.notificationID]).length) invalid();
      if (segment.completion !== 'done') pending = true;
      for (const table of ['session_message', 'session_inbox']) if (hasMigrationTable(db, table)) {
        const accepted = db.all(`SELECT session_id FROM ${table} WHERE id=?`, [segment.messageID]);
        if (accepted.some(row => row.session_id !== task.childSessionId)) invalid();
      }
    }
  }
  if (!hasMigrationTable(db, 'job')) {
    if (bound.size) invalid();
  } else {
    const rows = db.all('SELECT notification_id,id,session_id,child_session_id,kind,status,recovery FROM job ORDER BY notification_id');
    const sessions = new Map(db.all('SELECT id,parent_id,directory FROM session_v2').map(row => [row.id, row]));
    for (const row of rows) {
      let recovery;
      try { recovery = typeof row.recovery === 'string' ? JSON.parse(row.recovery) : row.recovery; } catch { invalid(); }
      const match = bound.get(row.id);
      if (typeof row.id === 'string' && row.id.startsWith('dvr_job_') && !match) invalid();
      if (row.kind !== 'subagent') { if (match) invalid(); continue; }
      const parent = sessions.get(row.session_id), child = sessions.get(row.child_session_id);
      if (!identity(row.notification_id) || !identity(row.id) || !isRecord(recovery) || recovery.kind !== 'subagent'
        || !['running', 'completed', 'error', 'cancelled'].includes(row.status)
        || recovery.parentSessionID !== row.session_id || recovery.childSessionID !== row.child_session_id
        || !parent || !child || child.parent_id !== parent.id) invalid();
      if (!match) continue;
      const { task, segment } = match;
      if (row.notification_id !== segment.notificationID || parent.id !== task.rootSessionId || child.id !== task.childSessionId
        || recovery.description !== task.taskId || recovery.agent !== task.agent
        || parent.directory !== task.directory || child.directory !== task.directory || segment.completion === 'done') invalid();
      pending = true;
    }
  }
  if (targetManifest !== undefined && !hasNativeManagedSubagentJobs(targetManifest) && pending) {
    throw bundleFailure('bundle_managed_jobs_incompatible');
  }
}
