import { AsyncLocalStorage } from 'node:async_hooks';

const context = new AsyncLocalStorage();
export const executionRemainingMs = () => Math.max(0, (context.getStore()?.deadline ?? Infinity) - Date.now());
export const executionDiagnostic = (record) => context.getStore()?.report?.(record);
export const executionSignal = () => context.getStore()?.signal;
export const checkExecutionAdmission = () => executionSignal()?.throwIfAborted();
export const executionProgressMeter = () => context.getStore()?.meter;
// Optional private-companion observations, never authorization inputs. Older
// companions remain valid and report unknown origin rather than a guessed one.
export const executionToolMetadata = (input) => ({
  ...(['builtin', 'custom'].includes(input?.toolOrigin) ? { toolOrigin: input.toolOrigin } : {}),
  ...(['direct-admit', 'direct-finish'].includes(input?.action) ? { executionTier: 'direct' }
    : ['control', 'process'].includes(input?.kind) ? { executionTier: input.kind } : {}),
  ...(['custom_tool', 'native_reads_disabled', 'direct_admission_failed'].includes(input?.fallbackReason)
    ? { fallbackReason: input.fallbackReason } : {}),
});
export const executionProgress = () => { const meter = executionProgressMeter(); if (meter) meter.progress = Date.now(); };
export const withExecutionSlotWait = async (action) => {
  const current = executionProgressMeter();
  if (current) current.waiters++;
  try { return await action(); }
  finally { if (current) { current.waiters--; current.progress = Date.now(); } }
};
export const withoutExecutionDeadline = (action) => context.run(context.getStore() ? { ...context.getStore(), signal: undefined, deadline: undefined } : undefined, action);

// Latest progress across a meter and the meters it follows (queued callers
// follow the current lock holder). A meter waiting on a bounded I/O slot is
// making progress by definition.
const followedProgress = (start) => {
  let progress = start.progress, waiting = false;
  const seen = new Set();
  for (let meter = start; meter && !seen.has(meter); meter = meter.following) {
    seen.add(meter); progress = Math.max(progress, meter.progress); waiting ||= meter.waiters > 0;
  }
  return { progress, waiting };
};

// With a summary, an admission journals one record carrying per-phase counts
// and time, and only when it failed or took at least `minMs`. A phase is still
// journaled immediately when it fails, and as started/completed once it runs
// for `slowMs` (default 2 s), so a hang remains visible while it happens.
const SLOW_PHASE_MS = 2_000;
const MAX_SUMMARY_STEPS = 32;
const recordStep = (current, phase, elapsedMs) => {
  const steps = current?.summary?.steps;
  if (!steps || (!steps.has(phase) && steps.size >= MAX_SUMMARY_STEPS)) return;
  const step = steps.get(phase) ?? { count: 0, elapsedMs: 0 };
  step.count += 1; step.elapsedMs += elapsedMs;
  steps.set(phase, step);
};
const formatSteps = (steps) => [...steps].map(([phase, step]) => `${phase}:${step.count}/${step.elapsedMs}`).join(',');

// Never race active work against a timer: the caller retains ownership until
// its filesystem operations, child processes and finalizers have settled.
// `timeoutMs` is an absolute cap. With `idleMs`, admission also expires once
// neither this work nor the lock holder it waits behind has progressed for
// that long, so queueing behind productive work does not end a turn.
export async function withExecutionAdmission(input, action, { timeoutMs = 25_000, idleMs, onDiagnostic, signal, summary } = {}) {
  const controller = new AbortController();
  const expired = Object.assign(new Error('local_execution_timeout'), { code: 'local_execution_timeout', status: 503 });
  const started = Date.now();
  const meter = { progress: started, waiters: 0 };
  const idle = Number.isFinite(idleMs) && idleMs > 0 && idleMs < timeoutMs ? idleMs : null;
  const timer = idle === null ? setTimeout(() => controller.abort(expired), timeoutMs) : setInterval(() => {
    const now = Date.now(), observed = followedProgress(meter);
    if (now - started >= timeoutMs || (!observed.waiting && now - observed.progress >= idle)) controller.abort(expired);
  }, Math.min(idle, 1000));
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const identity = { ...executionToolMetadata(input), ...Object.fromEntries(['sessionID', 'userMessageID', 'messageID', 'callID'].flatMap((key) =>
    typeof input[key] === 'string' && input[key].length <= 512 ? [[key, input[key]]] : [])) };
  const report = (record) => {
    try { onDiagnostic?.({ event: 'session_execution', ...identity, ...record }); } catch { /* Observer only. */ }
  };
  const summarized = summary ? { steps: new Map(), minMs: Math.max(0, Number(summary.minMs) || 0),
    slowMs: Number(summary.slowMs) > 0 ? Number(summary.slowMs) : SLOW_PHASE_MS } : undefined;
  try {
    return await context.run({ signal: combined, deadline: started + timeoutMs, report, meter, summary: summarized }, () => executionPhase('admission', action));
  } finally { clearTimeout(timer); clearInterval(timer); }
}

export async function executionPhase(phase, action) {
  const current = context.getStore();
  const started = Date.now();
  const summary = current?.summary;
  const slow = { reported: false, timer: null };
  if (!summary) current?.report?.({ phase, state: 'started' });
  else {
    slow.timer = setTimeout(() => { slow.reported = true; current.report?.({ phase, state: 'started', slow: true }); }, summary.slowMs);
    slow.timer.unref?.();
  }
  const settle = (record) => {
    clearTimeout(slow.timer);
    if (!summary) return current?.report?.(record);
    if (phase === 'admission') {
      if (record.state === 'failed' || record.elapsedMs >= summary.minMs) current.report?.({ ...record, steps: formatSteps(summary.steps) });
      return;
    }
    recordStep(current, phase, record.elapsedMs);
    if (slow.reported || record.state === 'failed' || record.elapsedMs >= summary.slowMs) current.report?.(record);
  };
  try {
    checkExecutionAdmission();
    const result = await action();
    checkExecutionAdmission();
    settle({ phase, state: 'completed', elapsedMs: Date.now() - started });
    return result;
  } catch (cause) {
    const failure = current?.signal?.aborted ? current.signal.reason
      : current && (cause?.name === 'TimeoutError' || ['capture_timeout', 'LOCK_TIMEOUT'].includes(cause?.code))
        ? Object.assign(new Error('local_execution_timeout', { cause }), { code: 'local_execution_timeout', status: 503 }) : cause;
    settle({ phase, state: 'failed', elapsedMs: Date.now() - started,
      code: ['local_execution_timeout', 'execution_preparation_stalled', 'execution_poller_lost',
        'workspace_changing', 'local_execution_cleanup_timeout'].includes(failure?.code) ? failure.code : 'local_execution_failed' });
    throw failure;
  }
}

// Diagnostics for high-frequency phases inside a transaction: only a failure,
// or a completion slower than `slowMs`, reaches the journal. Errors and
// cancellation semantics are identical to executionPhase.
export async function quietExecutionPhase(phase, action, slowMs = 250) {
  const current = context.getStore();
  const started = Date.now();
  try {
    checkExecutionAdmission();
    const result = await action();
    checkExecutionAdmission();
    const elapsedMs = Date.now() - started;
    recordStep(current, phase, elapsedMs);
    if (elapsedMs >= slowMs) current?.report?.({ phase, state: 'completed', elapsedMs, slow: true });
    return result;
  } catch (cause) {
    const failure = current?.signal?.aborted ? current.signal.reason
      : current && (cause?.name === 'TimeoutError' || ['capture_timeout', 'LOCK_TIMEOUT'].includes(cause?.code))
        ? Object.assign(new Error('local_execution_timeout', { cause }), { code: 'local_execution_timeout', status: 503 }) : cause;
    current?.report?.({ phase, state: 'failed', elapsedMs: Date.now() - started,
      code: ['local_execution_timeout', 'execution_preparation_stalled', 'execution_poller_lost',
        'workspace_changing', 'local_execution_cleanup_timeout'].includes(failure?.code) ? failure.code : 'local_execution_failed' });
    throw failure;
  }
}

// Only queue waiting may return early. The queued callback must still check
// the signal before acquiring a lock or changing durable state.
export async function waitForExecutionQueue(previous, progress) {
  const meter = executionProgressMeter();
  const following = meter?.following;
  if (meter && progress && meter !== progress) meter.following = progress;
  try { return await waitForQueue(previous); }
  finally {
    // Leaving the queue is progress: while queued, this caller followed the
    // holder, so its own meter is as old as its admission.
    if (meter) { meter.following = following; meter.progress = Date.now(); }
  }
}

// Work without an admission context still reports progress to callers that
// queue behind it (for example publication and revert transactions).
export const withExecutionMeter = (action) => {
  const current = context.getStore();
  if (current?.meter) return action();
  return context.run({ ...(current ?? {}), meter: { progress: Date.now(), waiters: 0 } }, action);
};

function waitForQueue(previous) {
  const signal = executionSignal();
  if (!signal) return previous;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    previous.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

export async function executionCleanup(action) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(Object.assign(new Error('local_execution_cleanup_timeout'), {
    code: 'local_execution_cleanup_timeout', status: 503,
  })), 5_000);
  try {
    return await context.run({ ...context.getStore(), signal: controller.signal }, () => executionPhase('cleanup', action));
  } finally { clearTimeout(timer); }
}

export async function withExecutionPreparation(input, action, { signal, onDiagnostic, summary, timeoutMs = 15 * 60_000, stallMs = 60_000 } = {}) {
  const controller = new AbortController();
  return withExecutionAdmission(input, async () => {
    const current = executionProgressMeter();
    const timer = setInterval(() => {
      // Copied admission contexts retain this meter. Joiners follow actual
      // producer progress without borrowing its cancellation or deadline.
      const { progress, waiting } = followedProgress(current);
      if (!waiting && Date.now() - progress >= stallMs) controller.abort(Object.assign(new Error('execution_preparation_stalled'), {
        code: 'execution_preparation_stalled', status: 503,
      }));
    }, Math.min(stallMs, 1000));
    try { return await executionPhase('preparation', action); }
    finally { clearInterval(timer); }
  }, { timeoutMs, onDiagnostic, summary, signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal });
}
