import { timeStartupPhase } from './startup-timing.js';

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
 */
export function createWebHostLifecycle({ construct, resetAfterStop }) {
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
      state = stoppedDuringStart ? 'stopped' : 'idle';
      throw error;
    }
  };

  // Called when a graceful shutdown completes, not when it is refused.
  const markStopped = () => {
    if (state === 'starting') stoppedDuringStart = true;
    else state = 'stopped';
  };

  return Object.freeze({ start, markStopped, getState: () => state });
}
