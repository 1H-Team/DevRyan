import { AsyncLocalStorage } from 'node:async_hooks';

const scopes = new AsyncLocalStorage();
const MAX_FAILURES = 32;
const clean = (text, limit) => String(text).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit);

// Never forward arbitrary NODE_OPTIONS, including a valid heap flag mixed with
// loaders/inspectors. Reconstruct the one accepted setting from its numeric value.
export function safeNodeHeapOption(value) {
  if (typeof value !== 'string' || value.length > 128) return '';
  const match = /^\s*--max-old-space-size(?:=|[ \t]+)([0-9]+)\s*$/.exec(value);
  const size = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(size) && size > 0 ? `--max-old-space-size=${size}` : '';
}

export function executionFailure(result) {
  if (result.timedOut || (result.exitCode === 0 && !result.signal)) return null;
  const exitCode = Number.isSafeInteger(result.exitCode) ? result.exitCode : null;
  const signal = typeof result.signal === 'string' && /^SIG[A-Z0-9]{1,16}$/.test(result.signal) ? result.signal : null;
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  const fatal = /(?:FATAL ERROR:|Assertion[^\r\n]{0,128}failed|Abort trap|Aborted|Segmentation fault)[^\r\n]{0,512}/i.exec(stderr)?.[0];
  const oom = /FATAL ERROR:[^\n]*(?:heap out of memory|Allocation failed[^\n]*memory|Failed to reserve[^\n]*memory)/i.test(stderr);
  const failureCategory = oom ? 'node_heap_exhausted'
    : signal === 'SIGABRT' || exitCode === 134 ? 'process_aborted'
      : signal ? 'process_signal' : 'command_failed';
  return { failureCategory, exitCode, signal, excerpt: fatal ? clean(fatal, 512) : 'No fatal diagnostic was captured.' };
}

export const executeFileWithFailureCapture = (executor, options) => executeWithFailureCapture(executor, options, 'executeFile');

export async function executeWithFailureCapture(executor, options, method = 'execute') {
  const result = await executor[method](options);
  const failure = executionFailure(result);
  if (failure) {
    const scope = scopes.getStore();
    if (scope) {
      scope.count++;
      scope.hasCrash ||= failure.failureCategory !== 'command_failed';
      if (scope.failures.length < MAX_FAILURES) scope.failures.push({ ...failure,
        label: options.devryanLabel ? clean(options.devryanLabel, 100) : null });
    }
    const { failureCategory, exitCode, signal } = failure;
    try { globalThis[Symbol.for('devryan.context-mode.call')]?.()?.onExecutionFailure?.({ failureCategory, exitCode, signal }); }
    catch { /* Diagnostics cannot change command settlement. */ }
  }
  return result;
}

export function captureExecutionIndex(operation) {
  try { return operation(); }
  catch (error) {
    const scope = scopes.getStore();
    if (scope) scope.indexingFailed = true;
    throw error;
  }
}

export function wrapExecutionFailures(handler) {
  return (...args) => scopes.run({ failures: [], count: 0, hasCrash: false, indexingFailed: false }, async () => {
    const scope = scopes.getStore();
    let result;
    try { result = await handler(...args); }
    catch (error) {
      if (!scope.count) throw error;
      result = { isError: true, content: [{ type: 'text', text: 'Output processing failed after command execution.' }] };
    }
    if (!scope.count) return result;
    const summaries = scope.failures.map((failure) => [
      `Execution failure${failure.label ? ` (${failure.label})` : ''}: ${failure.failureCategory}`,
      `Exit code: ${failure.exitCode ?? 'unavailable'}; signal: ${failure.signal ?? 'unavailable'}.`,
      failure.excerpt,
    ].join('\n'));
    if (scope.count > MAX_FAILURES) summaries.push(`${scope.count - MAX_FAILURES} additional command failures; inspect indexed batch output.`);
    if (scope.indexingFailed) summaries.unshift('Output indexing/retrieval failed separately; full output may be unavailable.');
    else summaries.push('For indexed output, use ctx_search with the source shown below to retrieve details.');
    summaries.push('This command was not replayed. Inspect state before retrying.');
    return { ...result, isError: Boolean(result?.isError) || scope.hasCrash, content: [{ type: 'text', text: summaries.join('\n\n') }, ...(result?.content ?? [])] };
  });
}
