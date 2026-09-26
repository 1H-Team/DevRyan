import { readSessionExecutionReceipt } from '@openchamber/harness-runtime/lib/session-execution.js';
import { cleanupExecutionLease } from '@openchamber/harness-runtime/lib/execution-cleanup.js';
import { withExecutionPreparation, withoutExecutionDeadline, executionRemainingMs, executionPhase, executionCleanup } from '@openchamber/harness-runtime/lib/execution-admission.js';

const failure = (code) => Object.assign(new Error(code), { code, status: 409 });

/** Polling waits never replay a tool. The preparation retains its own lifetime
 * until cancellation and all owned I/O have settled. */
export function createExecutionPreparations({ runtime, onDiagnostic, owner, pollMs = 20_000, ownerTimeoutMs = 60_000 }) {
  const jobs = new Map();
  const abandonOwned = async (job) => {
    if (job.claimed) return;
    clearInterval(job.timer);
    job.controller.abort(failure('execution_poller_lost'));
    await job.settled;
    await withoutExecutionDeadline(async () => {
      await runtime.cancelLease({ directory: job.lease.directory, token: job.lease.token });
      await cleanupExecutionLease(runtime, job.lease, onDiagnostic);
    });
    if (jobs.get(job.lease.token) === job) jobs.delete(job.lease.token);
  };
  const abandon = (job) => {
    if (job.claimed) return Promise.resolve();
    // Single-flight while an attempt runs; a failed cancellation or cleanup
    // must remain retryable by the next cancel, claim rollback or drain.
    return job.abandoning ??= abandonOwned(job).catch((error) => {
      job.abandoning = null;
      throw error;
    });
  };
  const start = (lease, input) => {
    owner.assert();
    if (jobs.has(lease.token)) return;
    const controller = new AbortController();
    const job = { controller, touched: Date.now(), lease, tool: input?.tool, requestDirectory: input?.directory ?? lease.directory, error: null, settled: null, done: false };
    jobs.set(lease.token, job);
    const timer = setInterval(() => {
      if (Date.now() - job.touched >= ownerTimeoutMs) {
        void abandon(job).catch(() => {});
      }
    }, Math.min(ownerTimeoutMs, 1000));
    job.timer = timer;
    job.settled = withExecutionPreparation({ ...input, ...lease.scope }, () => runtime.prepare(lease), {
      // One summary per preparation, with slow or failed phases journaled as they happen.
      signal: AbortSignal.any([owner.signal, controller.signal]), onDiagnostic, summary: { minMs: 0 },
    }).then((ready) => { job.lease = ready; }, async (cause) => {
      job.error = cause;
      await executionCleanup(async () => {
        await runtime.cancelLease({ directory: lease.directory, token: lease.token });
        await cleanupExecutionLease(runtime, lease, onDiagnostic);
      }).catch(() => {
        const identity = Object.fromEntries(['sessionID', 'userMessageID', 'messageID', 'callID'].flatMap(key =>
          typeof lease.scope?.[key] === 'string' && lease.scope[key].length <= 512 ? [[key, lease.scope[key]]] : []));
        try { onDiagnostic?.({ event: 'session_execution', ...identity, phase: 'cleanup', state: 'failed',
          code: 'execution_cleanup_unconfirmed' }); } catch { /* Observer only. */ }
      });
    }).finally(() => { job.done = true; });
  };
  const poll = async (lease, wait = true) => {
    owner.assert();
    const job = jobs.get(lease.token);
    if (!job) throw failure('execution_owner_unavailable');
    job.touched = Date.now();
    if (wait && !job.done) {
      let timer;
      // Identity and durable lease lookup already spent part of this request's
      // admission budget. Keep response headroom without ending the producer.
      // A poll wait reports no progress itself; stay inside the host's 25 s
      // idle admission budget as well as its absolute deadline.
      const waitMs = Math.max(0, Math.min(pollMs, 15_000, executionRemainingMs() - 1_000));
      try {
        await executionPhase('poll_wait', () => Promise.race([job.settled, new Promise((resolve) => {
          timer = setTimeout(resolve, waitMs);
        })]));
      } finally { clearTimeout(timer); }
    }
    if (job.error) return { protocol: 2, state: 'failed', lease: { token: lease.token }, error: { code: job.error.code || 'local_execution_failed' } };
    return { protocol: 2, state: job.done ? 'ready' : 'preparing', lease: job.lease };
  };
  const cancel = async (lease) => {
    const job = jobs.get(lease.token);
    if (job) await abandon(job);
  };
  // These jobs were admitted against canonical session/tool state at begin.
  // Polls only observe progress; claims still revalidate the durable lease.
  // In particular, polling must not queue behind the reconciliation it observes.
  const pollAuthenticated = async (input) => {
    owner.assert();
    const job = jobs.get(input.token);
    if (!job || job.claimed || job.abandoning || job.controller.signal.aborted) throw failure('execution_owner_unavailable');
    const lease = job.lease;
    if (lease.ownerID !== owner.id || job.requestDirectory !== input.directory || job.tool !== input.tool
      || ['sessionID', 'messageID', 'callID'].some(key => lease.scope[key] !== input[key])
      || lease.executionFingerprint !== input.argsDigest || !['control', 'process'].includes(input.kind)
      || (lease.preparation === 'none') !== (input.kind === 'control')) throw failure('capture_identity_mismatch');
    return poll(lease);
  };
  const claim = async (lease, action) => {
    const job = jobs.get(lease.token);
    owner.assert();
    if (!job || !job.done || job.error || job.controller.signal.aborted || job.claimed) throw failure('execution_not_ready');
    // Fence the poller timer synchronously before awaiting the durable claim.
    job.claimed = true; clearInterval(job.timer);
    try { const result = await action(); jobs.delete(lease.token); return result; }
    catch (cause) { job.claimed = false; await abandon(job).catch(() => {}); throw cause; }
  };
  return { start, poll, pollAuthenticated, cancel, claim, forget: (token) => { clearInterval(jobs.get(token)?.timer); jobs.delete(token); },
    drain: () => Promise.allSettled([...jobs.values()].map(abandon)) };
}

/** One uncertain lease must not prevent unrelated recoverable work settling. */
export async function recoverExecutionLeases({ runtime, directory, ownerLost, onFailure }) {
  const abandoned = async (lease) => {
    if (!lease.ownerID) throw failure('mutation_termination_unconfirmed');
    return ownerLost(lease);
  };
  for (const lease of await runtime.activeLeases({ directory })) {
    try {
      if (!await abandoned(lease)) continue;
      if (lease.executionKind === 'process') await readSessionExecutionReceipt(lease);
      await runtime.cancelLease(lease);
    } catch (cause) { onFailure(cause); }
  }
  for (const lease of await runtime.pendingCleanup({ directory })) {
    try {
      // A different living host may still be consuming this terminal view.
      if (!await abandoned(lease)) continue;
      if (!await runtime.cleanupLease(lease)) throw failure('execution_cleanup_pending');
    } catch (cause) { onFailure(cause); }
  }
}
