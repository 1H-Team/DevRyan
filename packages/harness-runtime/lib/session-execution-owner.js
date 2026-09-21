import { readSessionExecutionReceipt, startSessionExecution } from './session-execution.js';
import { cleanupExecutionLease } from './execution-cleanup.js';
import { createHash } from 'node:crypto';
import { withExecutionAdmission, withExecutionPreparation, withoutExecutionDeadline } from './execution-admission.js';

const failure = (code) => Object.assign(new Error(code), { code, status: 409 });

/** Owns native command lifetimes independently of project publication. Hosts
 * supply provider cancellation separately: cancelling a child process does not
 * prove that its parent model loop has stopped admitting more tool calls.
 */
export function createSessionExecutionOwner({ runtime, launcher, stopSessions, verifyLauncher, getHostOwner, onDiagnostic }) {
  const active = new Map();
  const supported = () => verifyLauncher({ launcher, platform: process.platform });
  const start = async (input) => {
    input.signal?.throwIfAborted();
    if (!await supported()) throw failure('mutation_runtime_unsupported');
    const environment = Object.entries(input.env ?? {}).sort(([a], [b]) => a.localeCompare(b));
    const executionFingerprint = createHash('sha256').update(JSON.stringify([input.command, input.args ?? [], environment,
      input.input === undefined ? null : createHash('sha256').update(input.input).digest('hex')])).digest('hex');
    const hostOwner = await getHostOwner?.();
    hostOwner?.assert();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, ...[input.signal, hostOwner?.signal].filter(Boolean)]);
    const lease = await withExecutionAdmission(input,
      () => runtime.reserve({ ...input, kind: 'process', executionFingerprint, ownerID: hostOwner?.id }), { signal });
    if (lease.state === 'published') return { lease, child: null, result: Promise.resolve({ ...await readSessionExecutionReceipt(lease), ...lease.result }) };
    if (hostOwner && lease.ownerID !== hostOwner.id) throw failure('execution_owner_lost');
    if (active.has(lease.token) || lease.executionKind) throw failure('execution_already_started');
    const owned = { lease, controller, settled: null };
    active.set(lease.token, owned);
    const started = Promise.withResolvers();
    owned.settled = (async () => {
      let handle;
      try {
        const ready = await withExecutionPreparation(input, () => runtime.prepare(lease), { signal });
        signal.throwIfAborted(); hostOwner?.assert();
        await runtime.claimLease({ directory: input.directory, token: lease.token, kind: 'process' });
        const workerInput = input.inputForLease ? await input.inputForLease(ready) : input.input;
        handle = await startSessionExecution({ launcher, lease: ready, command: input.command, args: input.args,
          env: input.environment ? await input.environment(ready) : input.env, signal, onOutput: input.onOutput,
          input: workerInput, interactive: input.interactive });
        handle.workerInput = workerInput;
        started.resolve(handle);
      } catch (cause) {
        // No supervisor was returned. The host still owns preparation and has
        // awaited all its I/O before recording this no-launch attestation.
        started.reject(cause);
        await withoutExecutionDeadline(async () => {
          await runtime.cancelUnstartedCall({ ...input, token: lease.token });
          await cleanupExecutionLease(runtime, { directory: input.directory, token: lease.token }, onDiagnostic);
        });
        throw signal.aborted ? failure('execution_cancelled') : cause;
      }
      const receipt = await handle.result;
      if (receipt.cancelled || signal.aborted || !receipt.confined) {
        await runtime.cancelLease({ directory: input.directory, token: lease.token });
        await cleanupExecutionLease(runtime, { directory: input.directory, token: lease.token }, onDiagnostic);
        throw failure(receipt.cancelled || signal.aborted ? 'execution_cancelled' : 'mutation_runtime_unsupported');
      }
      const publication = await runtime.finish({ directory: input.directory, token: lease.token });
      await cleanupExecutionLease(runtime, { directory: input.directory, token: lease.token }, onDiagnostic);
      return { ...receipt, ...publication };
    })().finally(() => { if (active.get(lease.token) === owned) active.delete(lease.token); });
    // Streaming adapters may not await settlement until after their output
    // reader drains. Attach a rejection handler immediately without hiding it.
    void owned.settled.catch(() => {});
    const handle = await started.promise;
    return { ...handle, lease, result: owned.settled };
  };
  const execute = async (input) => (await start(input)).result;
  return {
    start,
    execute,
    isConfined: supported,
    cancelAndWait: async (input) => {
      // The provider fence must acknowledge termination, not just request it.
      const provider = await stopSessions(input);
      if (provider?.terminated !== true || input.sessions.some((id) => !provider.sessions?.includes(id))) {
        throw failure('mutation_cancellation_failed');
      }
      const leases = await runtime.activeLeases(input);
      const pending = [];
      for (const lease of leases) {
        const owned = active.get(lease.token);
        // Unknown ownership after a restart needs a durable native receipt;
        // never infer process termination from an empty in-memory collection.
        if (!owned) {
          await readSessionExecutionReceipt(lease);
          await runtime.cancelLease({ directory: lease.directory, token: lease.token });
          continue;
        }
        if (owned.lease.directory !== lease.directory) throw failure('mutation_termination_unconfirmed');
        pending.push(owned.settled);
        owned.controller.abort();
      }
      const results = await Promise.allSettled(pending);
      for (const result of results) {
        if (result.status === 'rejected' && !['execution_cancelled', 'execution_reverted'].includes(result.reason?.code)) {
          throw failure('mutation_termination_unconfirmed');
        }
      }
      return { terminated: true, sessions: input.sessions };
    },
    drain: () => Promise.allSettled([...active.values()].map((owned) => owned.settled)),
  };
}
