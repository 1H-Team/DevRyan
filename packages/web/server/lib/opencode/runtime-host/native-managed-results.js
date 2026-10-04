import { isTerminalManagedTaskStatus, MANAGED_RESULT_PAGE_MAX_BYTES } from '@openchamber/orchestration-runtime';

const fault = code => Object.assign(new Error(code), { code, statusCode: 409 });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const key = (scope, taskID) => `${scope.directory}\0${scope.rootSessionId}\0${taskID}`;
const live = new Set(['queued', 'starting', 'running']);
export function validateNativeManagedResult(result, scope, taskID) {
  if (!record(result?.task) || result.task.taskId !== taskID || result.task.rootSessionId !== scope.rootSessionId
    || result.task.directory !== scope.directory || !(live.has(result.task.status) || isTerminalManagedTaskStatus(result.task.status))) {
    throw fault('native_task_result_scope_invalid');
  }
  if (result.resultEnvelope && (result.resultEnvelope.taskId !== taskID
    || result.resultEnvelope.rootSessionId !== scope.rootSessionId || result.resultEnvelope.directory !== scope.directory
    || result.resultEnvelope.status !== result.task.status)) throw fault('native_task_result_scope_invalid');
  return result;
}
const page = (value, expected) => {
  if (!record(value) || value.taskId !== expected.taskID || value.envelopeId !== expected.envelopeID
    || typeof value.text !== 'string' || Buffer.byteLength(value.text) > MANAGED_RESULT_PAGE_MAX_BYTES || !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 0
    || !Number.isSafeInteger(value.returnedBytes) || value.returnedBytes < 0 || value.returnedBytes > value.totalBytes
    || typeof value.complete !== 'boolean' || !(value.nextCursor === null || typeof value.nextCursor === 'string' && value.nextCursor.length > 0 && value.nextCursor.length <= 4096)
    || value.complete !== (value.nextCursor === null) || value.complete !== (value.returnedBytes === value.totalBytes)
    || expected.totalBytes !== undefined && value.totalBytes !== expected.totalBytes
    || expected.returnedBytes !== undefined && value.returnedBytes <= expected.returnedBytes
    || value.returnedBytes - (expected.returnedBytes ?? 0) !== Buffer.byteLength(value.text)) throw fault('native_task_result_page_invalid');
  return structuredClone(value);
};

/** Collection cursors are derived views, never task execution authority. The
 * existing scheduler remains the durable result and recovery owner. */
export function createNativeManagedResultCollection() {
  const collected = new Map();
  return {
    collect(result, scope, taskID) {
      validateNativeManagedResult(result, scope, taskID);
      if (!isTerminalManagedTaskStatus(result.task.status)) throw fault('native_task_wait_not_terminal');
      const envelope = result.resultEnvelope;
      if (!record(envelope) || typeof envelope.envelopeId !== 'string') throw fault('native_task_result_envelope_required');
      if (envelope.action !== null) { collected.delete(key(scope, taskID)); return; }
      const header = result.resultHeader;
      const compact = header?.schemaVersion === 1 && result.capabilities?.policies?.compactResults === true;
      if (header && (!compact || header.taskId !== taskID || header.envelopeId !== envelope.envelopeId
        || header.outcome?.status !== result.task.status || header.outcome?.partial !== envelope.partial
        || header.outcome?.disposition !== envelope.action || !Array.isArray(header.criticalFailures)
        || !Array.isArray(header.verification?.checks)
        || header.criticalFailures.some(value=>typeof value!=='string')
        || envelope.failureReason && !header.criticalFailures.includes(envelope.failureReason)
        || !['passed','failed','not-observed'].includes(header.verification.status)
        || header.verification.checks.some(check=>typeof check?.name!=='string'||!['passed','failed','not-observed'].includes(check.status))
        || ![null,'manual-attention','scheduled-recovery'].includes(header.recovery?.restriction)
        || header.recovery.resumable !== envelope.resumable
        || header.reported?.source !== 'retained-child-preview' || header.reported.authoritative !== false
        || !['complete','blocked','missing','ambiguous'].includes(header.reported.terminalMarker)
        || typeof header.detail?.requiredBeforeDisposition !== 'boolean')) throw fault('native_task_result_header_invalid');
      const detailRequired = !compact || header.detail?.requiredBeforeDisposition !== false;
      if (!detailRequired && (result.task.status !== 'completed' || envelope.partial
        || header.reported?.terminalMarker !== 'complete' || header.reported?.authoritative !== false
        || header.criticalFailures.length || header.recovery?.restriction !== null || header.verification.status !== 'passed'
        || !header.verification.checks.length || header.verification.checks.some(check => check.status !== 'passed'
          || check.evidence?.exitCode !== 0 || typeof check.coverage?.contentHash !== 'string'
          || check.coverage.contentHash !== check.evidence.checkedContentHash)
        || !Number.isSafeInteger(header.detail?.bytes) || header.detail.bytes >= 64 * 1024)) throw fault('native_task_result_header_invalid');
      const reference = result.resultReference ? page(result.resultReference, { taskID, envelopeID: envelope.envelopeId }) : undefined;
      if (compact && reference?.totalBytes !== header.detail?.bytes) throw fault('native_task_result_header_invalid');
      if (!reference && typeof envelope.recoverablePreview !== 'string') throw fault('native_task_result_detail_missing');
      const existing = collected.get(key(scope, taskID));
      if (existing?.envelopeID === envelope.envelopeId) return;
      collected.set(key(scope, taskID), { envelopeID: envelope.envelopeId, status: result.task.status, detailRequired,
        reference, complete: reference?.complete ?? true });
    },
    next(scope, taskID, cursor) {
      const value = collected.get(key(scope, taskID));
      if (!value) throw fault('native_task_wait_required');
      if (value.complete || value.reference?.nextCursor !== cursor) throw fault('native_task_result_cursor_mismatch');
      return structuredClone(value);
    },
    acceptPage(scope, taskID, cursor, result) {
      const current = this.next(scope, taskID, cursor);
      const reference = page(result?.resultReference, { taskID, envelopeID: current.envelopeID,
        totalBytes: current.reference.totalBytes, returnedBytes: current.reference.returnedBytes });
      collected.set(key(scope, taskID), { ...current, reference, complete: reference.complete });
    },
    assertDisposition(scope, taskID, action, current) {
      validateNativeManagedResult(current, scope, taskID);
      const value = collected.get(key(scope, taskID));
      if (!value) throw fault('native_task_wait_required');
      if (current.resultEnvelope?.envelopeId !== value.envelopeID || current.task.status !== value.status) throw fault('native_task_result_changed');
      if (current.resultEnvelope.action !== null) throw fault('native_task_already_dispositioned');
      if (value.status === 'completed' && action !== 'continue') throw fault('native_task_completed_requires_continue');
      if (current.task.manualRecoveryRequired === true || current.resultEnvelope.autoResume?.enabled === true
        && ['planning','scheduled','attempting'].includes(current.resultEnvelope.autoResume.state)) throw fault('manual_model_recovery_required');
      if (value.detailRequired && !value.complete) throw fault('native_task_result_detail_required');
    },
    dispose(scope, taskID) { collected.delete(key(scope, taskID)); },
  };
}
