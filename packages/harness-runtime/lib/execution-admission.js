import { AsyncLocalStorage } from 'node:async_hooks';

const context = new AsyncLocalStorage();
export const executionSignal = () => context.getStore()?.signal;
export const checkExecutionAdmission = () => executionSignal()?.throwIfAborted();
export const withoutExecutionDeadline = (action) => context.run(context.getStore() ? { ...context.getStore(), signal: undefined } : undefined, action);

// Never race active work against a timer: the caller retains ownership until
// its filesystem operations, child processes and finalizers have settled.
export async function withExecutionAdmission(input, action, { timeoutMs = 25_000, onDiagnostic, signal } = {}) {
  const controller = new AbortController();
  const expired = Object.assign(new Error('local_execution_timeout'), { code: 'local_execution_timeout', status: 503 });
  const timer = setTimeout(() => controller.abort(expired), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const identity = Object.fromEntries(['sessionID', 'userMessageID', 'messageID', 'callID'].flatMap((key) =>
    typeof input[key] === 'string' && input[key].length <= 512 ? [[key, input[key]]] : []));
  const report = (record) => {
    try { onDiagnostic?.({ event: 'session_execution', ...identity, ...record }); } catch { /* Observer only. */ }
  };
  try {
    return await context.run({ signal: combined, report }, () => executionPhase('admission', action));
  } finally { clearTimeout(timer); }
}

export async function executionPhase(phase, action) {
  const current = context.getStore();
  const started = Date.now();
  current?.report?.({ phase, state: 'started' });
  try {
    checkExecutionAdmission();
    const result = await action();
    checkExecutionAdmission();
    current?.report?.({ phase, state: 'completed', elapsedMs: Date.now() - started });
    return result;
  } catch (cause) {
    const failure = current?.signal?.aborted ? current.signal.reason
      : current && (cause?.name === 'TimeoutError' || ['capture_timeout', 'LOCK_TIMEOUT'].includes(cause?.code))
        ? Object.assign(new Error('local_execution_timeout', { cause }), { code: 'local_execution_timeout', status: 503 }) : cause;
    current?.report?.({ phase, state: 'failed', elapsedMs: Date.now() - started,
      code: failure?.code === 'local_execution_timeout' ? 'local_execution_timeout' : 'local_execution_failed' });
    throw failure;
  }
}

// Only queue waiting may return early. The queued callback must still check
// the signal before acquiring a lock or changing durable state.
export function waitForExecutionQueue(previous) {
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
