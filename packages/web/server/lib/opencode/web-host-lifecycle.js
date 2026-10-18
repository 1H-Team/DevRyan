import { timeStartupPhase } from './startup-timing.js';

const finiteCode = (error, fallback) => /^[a-z][a-z0-9_]{1,100}$/.test(error?.code ?? '') ? error.code : fallback;

const alreadyRunning = () => Object.assign(new Error('A DevRyan web host is already running in this process'), {
  code: 'web_host_already_running', status: 409,
});

/**
 * One web host at a time per process. ESM evaluates the composition module once;
 * this owner keeps its construction from overlapping. A start while another is
 * starting or running acquires nothing and fails with `web_host_already_running`.
 * A new start is allowed after the previous host finished shutting down or its
 * start failed: Electron's Startup Retry and its background-runtime handoff
 * fallback restart the in-process host that way. Restarting after a completed
 * shutdown first clears that shutdown's process state (`resetAfterStop`).
 *
 * A failed start owns what it acquired. `cleanupFailedStart` (the graceful
 * shutdown) closes admission, settles native execution and its durable
 * acknowledgements, and only then disposes dependent infrastructure. A refused
 * settlement keeps the journal, scheduler, stores and private execution bridge
 * so the start stays retryable. The original error is rethrown unchanged; the
 * cleanup outcome is reported separately as `error.startupCleanup`
 * (`released`, `retained` or `failed`, with a finite code).
 */
export function createWebHostLifecycle({ construct, resetAfterStop, cleanupFailedStart = async () => {}, log = console }) {
  let state = 'idle';
  let stoppedDuringStart = false;

  const start = async (options) => {
    if (state === 'starting' || state === 'running') throw alreadyRunning();
    const restarting = state === 'stopped';
    state = 'starting';
    stoppedDuringStart = false;
    try {
      if (restarting) resetAfterStop();
      const handle = await timeStartupPhase('web_host_construction', () => construct(options));
      state = stoppedDuringStart ? 'stopped' : 'running';
      return handle;
    } catch (error) {
      const cleanup = await releaseFailedStart();
      if (error && typeof error === 'object' && Object.isExtensible(error)) {
        Object.defineProperty(error, 'startupCleanup', { value: cleanup, enumerable: false, configurable: true });
      }
      state = stoppedDuringStart ? 'stopped' : 'idle';
      throw error;
    }
  };

  const releaseFailedStart = async () => {
    try {
      await cleanupFailedStart();
      return Object.freeze({ state: 'released', code: null });
    } catch (cleanupError) {
      // `retainedOwners`: settlement was refused before any owner was disposed,
      // so admission stays drained and the store owners stay alive for a retry.
      const cleanup = Object.freeze({
        state: cleanupError?.retainedOwners === true ? 'retained' : 'failed',
        code: finiteCode(cleanupError, 'web_host_start_cleanup_failed'),
      });
      log.warn?.('[web-host] failed start cleanup did not complete', cleanup);
      return cleanup;
    }
  };

  // Called when a graceful shutdown completes, not when it is refused.
  const markStopped = () => {
    if (state === 'starting') stoppedDuringStart = true;
    else state = 'stopped';
  };

  return Object.freeze({ start, markStopped, getState: () => state });
}
