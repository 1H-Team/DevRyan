import { timeStartupPhase } from './startup-timing.js';

const finiteCode = (error, fallback) => /^[a-z][a-z0-9_]{1,100}$/.test(error?.code ?? '') ? error.code : fallback;

const alreadyRunning = () => Object.assign(new Error('A DevRyan web host is already running in this process'), {
  code: 'web_host_already_running', status: 409,
});

/**
 * One web host at a time per process. Each construction builds its own owners
 * (`constructWebHost` in application.js); this owner keeps constructions from
 * overlapping. A start while another is starting or running acquires nothing
 * and fails with `web_host_already_running`. A new start is allowed after the
 * previous host finished shutting down or its start failed: Electron's Startup
 * Retry and its background-runtime handoff fallback restart the in-process host
 * that way. Restarting after a completed shutdown first clears that shutdown's
 * process state (`resetAfterStop`).
 *
 * A failed start owns what it acquired. `cleanupFailedStart` (that host's
 * graceful shutdown) closes admission, settles native execution and its durable
 * acknowledgements, and only then disposes dependent infrastructure. The
 * original error is rethrown unchanged; the cleanup outcome is reported
 * separately as `error.startupCleanup` (`released`, `retained` or `failed`,
 * with a finite code). A refused settlement retains the partial host's owners:
 * the next start settles that host first and constructs only once it is
 * released, so two native owners never coexist. If the settlement is refused
 * again, that start fails with `web_host_start_cleanup_incomplete`.
 */
export function createWebHostLifecycle({ construct, resetAfterStop, cleanupFailedStart, log = console }) {
  let state = 'idle';
  let stoppedDuringStart = false;
  let retained = false;
  let releasing = false;

  const releaseFailedStart = async () => {
    releasing = true;
    try {
      await cleanupFailedStart();
      return { outcome: Object.freeze({ state: 'released', code: null }) };
    } catch (cleanupError) {
      // `retainedOwners`: settlement was refused before any owner was disposed,
      // so admission stays drained and the store owners stay alive for a retry.
      const outcome = Object.freeze({
        state: cleanupError?.retainedOwners === true ? 'retained' : 'failed',
        code: finiteCode(cleanupError, 'web_host_start_cleanup_failed'),
      });
      log.warn?.('[web-host] failed start cleanup did not complete', outcome);
      return { outcome, cleanupError };
    } finally {
      releasing = false;
    }
  };

  const start = async (options) => {
    if (state === 'starting' || state === 'running') throw alreadyRunning();
    let restarting = state === 'stopped';
    state = 'starting';
    stoppedDuringStart = false;
    if (retained) {
      const { outcome, cleanupError } = await releaseFailedStart();
      if (outcome.state === 'retained') {
        state = 'idle';
        throw Object.assign(new Error('The previous failed start still holds its owners', { cause: cleanupError }), {
          code: 'web_host_start_cleanup_incomplete', status: 409, startupCleanup: outcome,
        });
      }
      retained = false;
      restarting = true;
    }
    try {
      if (restarting) resetAfterStop();
      const handle = await timeStartupPhase('web_host_construction', () => construct(options));
      state = stoppedDuringStart ? 'stopped' : 'running';
      return handle;
    } catch (error) {
      if (!cleanupFailedStart) {
        state = stoppedDuringStart ? 'stopped' : 'idle';
        throw error;
      }
      const { outcome } = await releaseFailedStart();
      if (error && typeof error === 'object' && Object.isExtensible(error)) {
        Object.defineProperty(error, 'startupCleanup', { value: outcome, enumerable: false, configurable: true });
      }
      retained = outcome.state === 'retained';
      // Released or failed after settlement: that host is gone, so the next
      // start clears its shutdown first.
      state = retained ? 'idle' : 'stopped';
      throw error;
    }
  };

  // Called when a graceful shutdown completes, not when it is refused. During a
  // failed start's cleanup it reports that cleanup, not a concurrent stop.
  const markStopped = () => {
    if (releasing) return;
    if (state === 'starting') stoppedDuringStart = true;
    else state = 'stopped';
  };

  return Object.freeze({ start, markStopped, getState: () => state, hasRetainedHost: () => retained });
}
