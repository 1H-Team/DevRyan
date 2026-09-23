import { executionSignal, checkExecutionAdmission, executionPhase, withExecutionAdmission } from '@openchamber/harness-runtime/lib/execution-admission.js';
import { cleanupExecutionLease } from '@openchamber/harness-runtime/lib/execution-cleanup.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSessionMutationRuntime } from '@openchamber/harness-runtime';
import { prepareSessionExecution, readSessionExecutionReceipt, verifySessionExecutionLauncher, startReadOnlySessionExecution } from '@openchamber/harness-runtime/lib/session-execution.js';
import { createScopedRevertCoordinator } from './session-revert-coordinator.js';
import { createSessionExecutionOwner } from '@openchamber/harness-runtime/lib/session-execution-owner.js';
import { CURSOR_PROVIDER_ID } from '@openchamber/cursor-sdk-runtime';
import { createExecutionHostOwner, executionHostOwnerLost, executionOwnerFactory } from '@openchamber/harness-runtime/lib/execution-host-owner.js';
import { createExecutionPreparations, recoverExecutionLeases } from './execution-preparations.js';

const failure = (code, status = 409) => Object.assign(new Error(code), { code, status });
const identity = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,512}$/.test(value);

/** Private bridge for the pinned companion. Its bearer credential belongs to
 * the model/control process and must never enter a confined tool's environment.
 * Every writer, including a failed command, needs a native termination receipt
 * before publication. Legacy observations never become ownership evidence.
 */
export function createSessionExecutionHost(options) {
  const runtime = createSessionMutationRuntime({ directory: path.join(options.dataDirectory, 'harness', 'session-mutations') });
  const request = async (pathname, directory, body) => {
    const url = new URL(options.buildOpenCodeUrl(pathname, '')); url.searchParams.set('directory', directory);
    const response = await (options.fetchImpl ?? fetch)(url, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...options.getOpenCodeAuthHeaders?.(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(executionSignal() ? [executionSignal()] : [])]) });
    if (!response.ok) throw failure(response.status === 404 ? 'mutation_history_unavailable' : 'mutation_runtime_unavailable');
    return response.json();
  };
  const session = async (input) => {
    if (!identity(input.sessionID) || !path.isAbsolute(input.directory ?? '')) throw failure('invalid_capture_identity', 400);
    const info = await request(`/session/${input.sessionID}`, input.directory);
    if (info?.id !== input.sessionID || typeof info.directory !== 'string'
      || await fs.realpath(info.directory) !== await fs.realpath(input.directory)) throw failure('session_directory_mismatch');
    return info;
  };
  const launcher = () => options.getLauncher();
  const ownerDirectory = path.join(options.dataDirectory, 'harness', 'execution-owners');
  let preparationHost;
  // Preparations of a lost keeper already observe its aborted signal; they
  // finish draining in the background and remain part of shutdown drain.
  const retiredPreparations = new Set();
  const createPreparations = executionOwnerFactory(async () => {
    const owner = await createExecutionHostOwner({ directory: ownerDirectory, launcher: launcher() });
    return { owner, jobs: createExecutionPreparations({ runtime, owner, onDiagnostic: options.onDiagnostic }) };
  }, {
    retire: async ({ owner, jobs }) => {
      const draining = jobs.drain().finally(() => retiredPreparations.delete(draining));
      retiredPreparations.add(draining);
      try { options.onDiagnostic?.({ event: 'session_execution', phase: 'owner_replacement', state: 'started' }); } catch { /* Observer only. */ }
      await owner.close();
    },
  });
  const preparations = () => preparationHost = createPreparations();
  const cleanup = (lease) => cleanupExecutionLease(runtime, lease, options.onDiagnostic);
  const cursorOwners = new Map();
  let retentionReady = false;
  const activity = (ids, action) => options.activityGate ? options.activityGate.run(ids, action) : action();
  const cursorOwner = () => {
    const binary = launcher();
    if (!cursorOwners.has(binary)) cursorOwners.set(binary, createSessionExecutionOwner({ runtime, launcher: binary,
      verifyLauncher: verifySessionExecutionLauncher, onDiagnostic: options.onDiagnostic, getHostOwner: async () => (await preparations()).owner, stopSessions: async ({ sessions }) => {
        for (const sessionID of sessions) await options.stopCursor?.({ sessionID });
        return { terminated: true, sessions };
      } }));
    return cursorOwners.get(binary);
  };
  const isConfined = async ({ directory }) => {
    if (!await verifySessionExecutionLauncher({ launcher: launcher() })) return false;
    const capability = await request('/session/revert-capabilities', directory).catch(() => null);
    return capability?.legacyConversationRevert === 1 && capability?.executionBoundary === 1;
  };
  const executions = {
    isConfined,
    cancelAndWait: async (input) => {
      // Cancellation in the compatible companion waits for the model fiber and
      // tool finalizers. Cursor has an independent host-owned settlement edge.
      for (const sessionID of input.sessions) {
        const current = await request(`/session/${sessionID}`, input.directory);
        if (current?.id !== sessionID || typeof current.directory !== 'string'
          || await runtime.projectDirectory({ directory: current.directory }) !== await runtime.projectDirectory(input)) throw failure('session_directory_mismatch');
        await options.stopCursor?.({ directory: current.directory, sessionID });
        if (await request(`/session/${sessionID}/abort`, current.directory, {}) !== true) throw failure('mutation_cancellation_failed');
      }
      for (const lease of await runtime.activeLeases(input)) {
        if (lease.executionKind === 'process') await readSessionExecutionReceipt(lease);
        await runtime.cancelLease({ directory: lease.directory, token: lease.token });
      }
      return { terminated: true, sessions: input.sessions };
    },
  };
  const rawCoordinator = createScopedRevertCoordinator({ runtime, executions, openchamberDataDir: options.dataDirectory,
    buildOpenCodeUrl: options.buildOpenCodeUrl, getOpenCodeAuthHeaders: options.getOpenCodeAuthHeaders,
    fetchImpl: options.fetchImpl, onDiagnostic: options.onDiagnostic });
  const coordinator = Object.fromEntries(Object.entries(rawCoordinator).map(([name, action]) => [name, typeof action === 'function'
    ? (input) => activity([input?.sessionID], () => action(input)) : action]));
  const persistCursorRecord = async ({ sessionID, directory, record }) => {
    await runtime.assertAdmission({ directory, sessionID });
    await session({ sessionID, directory });
    if (!await isConfined({ directory })) throw failure('mutation_runtime_unsupported');
    if (record?.info?.sessionID !== sessionID) throw failure('capture_identity_mismatch');
    const info = record.info, agent = info.agent || 'build';
    const normalized = { ...record, info: info.role === 'user'
      ? { ...info, agent, model: { providerID: CURSOR_PROVIDER_ID, modelID: info.modelID } }
      : { ...info, agent, mode: info.mode || agent, path: { cwd: directory, root: directory }, cost: info.cost ?? 0,
        tokens: info.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } };
    const result = await request(`/session/${sessionID}/external-message`, directory, normalized).catch(async (cause) => {
      // Admission may have closed after our first check, while this HTTP
      // persistence was in flight. Preserve that specific cancellation result.
      await runtime.assertAdmission({ directory, sessionID });
      throw cause;
    });
    if (info.role === 'assistant') {
      const lease = await runtime.leaseForCall({ directory, sessionID, callID: `cursor_${info.id}` });
      if (lease?.state === 'published') await cursorReceipts(lease, normalized);
    }
    return result;
  };
  const cursorReceipts = async (lease, record) => {
    const receipt = await runtime.executionReceipt({ directory: lease.directory, token: lease.token });
    await options.recordReceipt?.({ ...receipt, tool: 'cursor_sdk' });
    const calls = record.parts.filter((part) => part.type === 'tool');
    await runtime.aliasCalls({ directory: lease.directory, token: lease.token, calls: calls.map((part) => part.callID) });
    // The SDK is one confined turn. Its internal tool rows share that owned
    // publication; empty attestations close observation windows without
    // counting the same bytes once per internal tool.
    for (const part of calls) await options.recordReceipt?.({ ...receipt, callID: part.callID, tool: part.tool, files: [] });
  };
  const startCursor = async (input) => {
    options.assertExecutionReady?.();
    const current = await session(input);
    if (!await isConfined(input)) throw failure('mutation_runtime_unsupported');
    const record = await request(`/session/${input.sessionID}/message/${input.assistantMessageID}`, input.directory);
    if (record?.info?.providerID !== CURSOR_PROVIDER_ID || record.info.parentID !== input.messageID) throw failure('capture_identity_mismatch');
    const handle = await cursorOwner().start({ directory: input.directory, sessionID: input.sessionID,
      userMessageID: input.messageID, messageID: input.assistantMessageID, callID: `cursor_${input.assistantMessageID}`,
      parentID: current.parentID, command: input.command, args: input.args, env: input.env, interactive: true,
      signal: input.signal, input: input.input, inputForLease: input.inputForLease,
      environment: async (lease) => {
        const scratch = path.join(path.dirname(lease.viewDirectory), 'scratch');
        const env = { ...input.env, HOME: scratch, XDG_CONFIG_HOME: path.join(scratch, 'config'), XDG_DATA_HOME: path.join(scratch, 'data'),
          XDG_CACHE_HOME: path.join(scratch, 'cache'), XDG_STATE_HOME: path.join(scratch, 'state'),
          DEVRYAN_LOGICAL_DIRECTORY: input.directory };
        for (const key of Object.keys(env)) if (/^(DEVRYAN_.*(?:TOKEN|URL)|OPENCODE_SERVER_(?:PASSWORD|USERNAME))$/.test(key)) delete env[key];
        return env;
      },
    });
    const result = handle.result.then(async (value) => {
      const record = await request(`/session/${input.sessionID}/message/${input.assistantMessageID}`, input.directory);
      await cursorReceipts(handle.lease, record);
      return value;
    });
    void result.catch(() => {});
    return { ...handle, result };
  };
  const dispatch = async (input) => {
    options.assertExecutionReady?.();
    if (input.protocol === 2 && input.action === 'prepare-poll') {
      if (!preparationHost) throw failure('execution_owner_unavailable');
      return executionPhase('preparation_poll', async () => (await preparationHost).jobs.pollAuthenticated(input));
    }
    const current = await executionPhase('identity_lookup', () => session(input));
    if (!await verifySessionExecutionLauncher({ launcher: launcher() })) throw failure('mutation_runtime_unsupported');
    if (input.action === 'admit') return runtime.assertAdmission(input);
    if (input.action === 'child') {
      if (current.parentID !== input.parentID) throw failure('invalid_session_lineage');
      return runtime.registerChild(input);
    }
    if (input.action === 'prompt') {
      if (!identity(input.userMessageID)) throw failure('invalid_capture_identity', 400);
      const record = await request(`/session/${input.sessionID}/message/${input.userMessageID}`, input.directory);
      if (record?.info?.id !== input.userMessageID || record.info.role !== 'user' || record.info.sessionID !== input.sessionID) {
        throw failure('capture_identity_mismatch');
      }
      return runtime.registerPrompt({ ...input, parentID: current.parentID });
    }
    if (!identity(input.messageID) || !identity(input.callID)) throw failure('invalid_capture_identity', 400);
    const record = await executionPhase('tool_identity_lookup', () => request(`/session/${input.sessionID}/message/${input.messageID}`, input.directory));
    const call = record?.parts?.find((part) => part.type === 'tool' && part.callID === input.callID);
    if (record?.info?.role !== 'assistant' || record.info.sessionID !== input.sessionID || !call || call.tool !== input.tool) {
      throw failure('capture_identity_mismatch');
    }
    if (input.action === 'begin') {
      if (!/^[a-f0-9]{64}$/.test(input.argsDigest ?? '')) throw failure('invalid_capture_identity', 400);
      const executionFingerprint = input.argsDigest;
      if (input.protocol === 2) {
        if (!['control', 'process'].includes(input.kind)) throw failure('invalid_capture_identity', 400);
        const { owner, jobs } = await preparations(); owner.assert();
        const lease = await runtime.reserve({ ...input, userMessageID: record.info.parentID, parentID: current.parentID,
          executionFingerprint, ownerID: owner.id });
        if (lease.ownerID !== owner.id) {
          if (await executionHostOwnerLost({ directory: ownerDirectory, launcher: launcher(), id: lease.ownerID }) && !lease.executionKind) {
            await runtime.cancelLease({ directory: lease.directory, token: lease.token });
          }
          throw failure('execution_owner_lost');
        }
        if (lease.executionKind || lease.state === 'published') throw failure('execution_already_started');
        jobs.start(lease, input);
        return jobs.poll(lease, false);
      }
      const lease = await executionPhase('lease_preparation', () => runtime.begin({ ...input, userMessageID: record.info.parentID, parentID: current.parentID, executionFingerprint }));
      checkExecutionAdmission();
      await runtime.claimLease({ directory: input.directory, token: lease.token, kind: input.kind });
      if (input.kind === 'control') return { lease };
      try { return { lease, launch: await prepareSessionExecution({ launcher: launcher(), lease }) }; }
      catch (cause) {
        await runtime.cancelUnstartedCall({ ...input, token: lease.token });
        await cleanup({ directory: input.directory, token: lease.token });
        throw cause;
      }
    }
    if (input.action === 'cancel-before-start') {
      // Only the trusted companion can attest that it never spawned a process.
      const lease = await executionPhase('lease_lookup', () => runtime.leaseForCall(input));
      if (lease && preparationHost) await (await preparationHost).jobs.cancel(lease);
      await runtime.cancelUnstartedCall(input);
      if (lease) await cleanup(lease);
      return { cancelled: true };
    }
    const lease = await executionPhase('lease_lookup', () => runtime.leaseForCall(input));
    if (!lease || lease.token !== input.token || lease.scope.messageID !== input.messageID) throw failure('capture_identity_mismatch');
    if (input.protocol === 2 && input.action === 'claim') {
      if (lease.executionFingerprint !== input.argsDigest || (lease.preparation === 'none') !== (input.kind === 'control')) {
        throw failure('capture_identity_mismatch');
      }
      const { owner, jobs } = await preparations(); owner.assert();
      if (lease.ownerID !== owner.id) throw failure('execution_owner_lost');
      await executionPhase('execution_claim', () => jobs.claim(lease, () => runtime.claimLease({ directory: input.directory, token: lease.token, kind: input.kind })));
      owner.assert();
      if (input.kind === 'control') return { lease };
      try { return { lease, launch: await prepareSessionExecution({ launcher: launcher(), lease }) }; }
      catch (cause) {
        await runtime.cancelUnstartedCall({ ...input, token: lease.token });
        await cleanup({ directory: input.directory, token: lease.token });
        throw cause;
      }
    }
    if (input.action !== 'finish') throw failure('invalid_capture_identity', 400);
    if (lease.executionKind !== 'control') {
      const receipt = await readSessionExecutionReceipt(lease);
      if (receipt.cancelled || !receipt.confined) {
        await runtime.cancelLease({ directory: input.directory, token: lease.token });
        throw failure(receipt.cancelled ? 'execution_cancelled' : 'mutation_runtime_unsupported');
      }
    }
    const result = await runtime.finish({ directory: input.directory, token: lease.token });
    await options.recordReceipt?.({ ...await runtime.executionReceipt({ directory: input.directory, token: lease.token }), tool: input.tool });
    await cleanup({ directory: input.directory, token: lease.token });
    return result;
  };
  const dispatchPlugin = (input) => ['admit', 'prompt', 'begin', 'child', 'cancel-before-start', 'prepare-poll', 'claim'].includes(input.action)
    // Fail after 25 s without progress (this request's own work or the lock
    // holder it queues behind), never later than 50 s: the companion's RPC
    // limit is 60 s, and deadline-free commits may run past the abort.
    ? withExecutionAdmission(input, () => executionPhase(input.action === 'cancel-before-start' ? 'cleanup' : 'host_request', () => dispatch(input)), {
      timeoutMs: options.admissionTimeoutMs ?? 50_000, idleMs: options.admissionIdleMs ?? 25_000, onDiagnostic: options.onDiagnostic,
      // Healthy host requests are frequent and fast; they are journaled only when slow or failed.
      summary: { minMs: 250 },
    }) : dispatch(input);
  const plugin = (input) => activity([input.sessionID, input.parentID], () => dispatchPlugin(input));
  return { get retentionReady() { return retentionReady; }, runtime, executions, coordinator, plugin, isConfined, persistCursorRecord, startCursor,
    recover: async () => {
      retentionReady = false; let failed = false;
      const report = (cause) => {
        failed = true;
        try { options.onDiagnostic?.({ event: 'session_revert', phase: 'recovery_failed', code: cause.code || 'mutation_recovery_required' }); } catch { /* Observer only. */ }
      };
      for (const directory of await runtime.projectDirectories()) {
        try {
          if (!await isConfined({ directory })) { failed = true; continue; }
          try { await coordinator.recover({ directory }); } catch (cause) { report(cause); }
          await recoverExecutionLeases({ runtime, directory, onFailure: report,
            ownerLost: (lease) => executionHostOwnerLost({ directory: ownerDirectory, launcher: launcher(), id: lease.ownerID }) });
        } catch (cause) { report(cause); }
      }
      retentionReady = !failed;
    },
    startReadOnly: (input) => { options.assertExecutionReady?.(); return startReadOnlySessionExecution({ ...input, launcher: launcher(),
      storage: path.join(options.dataDirectory, 'harness', 'provider-executions'), interactive: true }); },
    beforeCursorPrompt: async (input) => { options.assertExecutionReady?.(); await runtime.assertAdmission(input); return (await session(input)).revert ?? null; },
    drain: async () => {
      // A failed keeper must not prevent independent owners and I/O draining.
      const results = await Promise.allSettled([
        // A keeper that never started owns nothing to drain; only an
        // unconfirmed termination remains a shutdown failure.
        preparationHost?.then(async (host) => { try { await host.jobs.drain(); } finally { await host.owner.close(); } },
          (cause) => { if (cause?.code === 'execution_owner_termination_unconfirmed') throw cause; }),
        ...retiredPreparations,
        ...[...cursorOwners.values()].map((owner) => owner.drain()),
      ]);
      await runtime.drain();
      const failed = results.find((result) => result.status === 'rejected');
      if (failed) throw failed.reason;
    } };
}
