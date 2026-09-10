const PHASES = new Set(['execution_failed', 'queued', 'dispatched', 'initializing', 'executing', 'completed', 'failed', 'cancelled',
  'cancelled_queued', 'queue_timeout', 'timeout', 'unavailable', 'worker_exit', 'quarantined', 'recovered',
  'worker_started', 'worker_reused', 'worker_retiring', 'worker_retired', 'storage_contended', 'storage_acquired']);
const identifier = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(value);

// Private bridge input is still untrusted. Copy only bounded correlation data;
// never forward supplied arguments, paths, error text, or arbitrary properties.
export function recordContextModeDiagnostic(params, record) {
  if (!params || !PHASES.has(params.phase) || !identifier(params.sessionID)
    || (params.messageID !== null && !identifier(params.messageID))
    || !identifier(params.workerCallID) || (params.callID !== null && !identifier(params.callID))
    || typeof params.tool !== 'string' || !/^ctx_[a-z_]{1,64}$/.test(params.tool)
    || !Number.isFinite(params.elapsedMs) || params.elapsedMs < 0
    || !Number.isSafeInteger(params.sequence) || params.sequence < 1
    || !Number.isSafeInteger(params.sourceAt) || params.sourceAt < 0
    || !Number.isSafeInteger(params.droppedEvents) || params.droppedEvents < 0
    || !Number.isFinite(params.budgetMs) || params.budgetMs <= 0) {
    throw new TypeError('Invalid Context Mode diagnostic');
  }
  const failure = {};
  if (params.phase === 'execution_failed') {
    if (!['node_heap_exhausted', 'process_aborted', 'process_signal', 'command_failed'].includes(params.failureCategory)
      || (params.exitCode !== null && (!Number.isSafeInteger(params.exitCode) || params.exitCode < 0 || params.exitCode > 4294967295))
      || (params.signal !== null && (typeof params.signal !== 'string' || !/^SIG[A-Z0-9]{1,16}$/.test(params.signal)))) {
      throw new TypeError('Invalid Context Mode execution failure');
    }
    Object.assign(failure, { failureCategory: params.failureCategory, exitCode: params.exitCode, signal: params.signal });
  }
  if (params.droppedEvents) record({ type: 'gap', event: 'context_mode.diagnostics_gap',
    sessionID: params.sessionID, payload: { droppedEvents: params.droppedEvents } });
  record({ type: 'lifecycle', event: `context_mode.${params.phase}`, sessionID: params.sessionID,
    payload: { ...failure, phase: params.phase, callID: params.callID, messageID: params.messageID, workerCallID: params.workerCallID,
      tool: params.tool, sequence: params.sequence, sourceAt: params.sourceAt, elapsedMs: params.elapsedMs, budgetMs: params.budgetMs } });
  return { ok: true };
}
