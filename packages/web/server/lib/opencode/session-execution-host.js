import { executionSignal, checkExecutionAdmission, executionPhase, executionStep, timedExecutionStep, withExecutionAdmission, withExecutionPreparation, withExecutionSummary } from '@openchamber/harness-runtime/lib/execution-admission.js';
import { classifySessionChangeTool } from '@openchamber/harness-runtime/lib/session-changes-tools.js';
import { cleanupExecutionLease } from '@openchamber/harness-runtime/lib/execution-cleanup.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSessionMutationRuntime } from '@openchamber/harness-runtime';
import { prepareSessionExecution, readSessionExecutionReceipt, verifySessionExecutionLauncher, startReadOnlySessionExecution, sweepExecutionSocketDirectories } from '@openchamber/harness-runtime/lib/session-execution.js';
import { createScopedRevertCoordinator } from './session-revert-coordinator.js';
import { createSessionExecutionOwner } from '@openchamber/harness-runtime/lib/session-execution-owner.js';
import { CURSOR_PROVIDER_ID } from '@openchamber/cursor-sdk-runtime';
import { createExecutionHostOwner, executionHostOwnerLost, executionOwnerFactory } from '@openchamber/harness-runtime/lib/execution-host-owner.js';
import { createExecutionPreparations, recoverExecutionLeases } from './execution-preparations.js';
import { createExecutionIdleWatchdog } from '@openchamber/harness-runtime/lib/execution-idle-watchdog.js';

const failure = (code, status = 409) => Object.assign(new Error(code), { code, status });
// Built-in tools the companion may run with a direct receipt: audited
// read-only (companion/SEAMS.md). The companion selects them by object
// identity; the name check here is defense in depth.
const DIRECT_RECEIPT_TOOLS = new Set(['read', 'glob', 'grep', 'skill']);
// Admission times of direct calls, keyed by admission token, so a finish can
// journal how long the tool ran in the companion. Bounded; a call that never
// finishes (cancelled, crashed) is evicted by later admissions.
const DIRECT_ADMISSIONS_MAX = 1024;
const identity = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,512}$/.test(value);

/** Private bridge for the pinned companion. Its bearer credential belongs to
 * the model/control process and must never enter a confined tool's environment.
 * Every writer, including a failed command, needs a native termination receipt
 * before publication. Legacy observations never become ownership evidence.
 */
export function createSessionExecutionHost(options) {
  const runtime = createSessionMutationRuntime({ directory: path.join(options.dataDirectory, 'harness', 'session-mutations'),
    // Ledger maintenance and input-classification failures reach the journal.
    onDiagnostic: (record) => { try { options.onDiagnostic?.({ event: 'session_execution', ...record }); } catch { /* Observer only. */ } } });
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
  // Ends a confined command whose whole process tree has been idle for ten
  // minutes (execution-idle-watchdog.js). It never touches a launch.
  const idleWatchdog = options.idleWatchdog ?? createExecutionIdleWatchdog({ onDiagnostic: options.onDiagnostic });
  const launchWatched = async (lease, input) => {
    const launch = await prepareSessionExecution({ launcher: launcher(), lease });
    idleWatchdog.watch({ token: lease.token, profile: launch.profile,
      identity: { sessionID: input.sessionID, messageID: input.messageID, callID: input.callID } });
    return launch;
  };
  const directAdmissions = new Map();
  // Claim times of control and process calls, keyed by lease token, so a
  // finish can journal how long the tool ran between its claim and its finish.
  // Bounded like directAdmissions.
  const claims = new Map();
  const claimed = (lease) => {
    claims.set(lease.token, Date.now());
    while (claims.size > DIRECT_ADMISSIONS_MAX) claims.delete(claims.keys().next().value);
  };
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
  // A cancelled confined call published nothing: its private view was
  // discarded. Record that, or the conversation's change record stays
  // incomplete ("a tool did not provide a complete record of its file edits")
  // after every Stop and every task deadline. Best effort: the cancellation
  // itself is already durable. Kill switch: DEVRYAN_CANCELLED_RECEIPTS=0.
  const recordCancelled = async (lease, tool) => {
    if (process.env.DEVRYAN_CANCELLED_RECEIPTS === '0' || !lease?.scope?.sessionID || !lease.scope.messageID || !lease.scope.callID
      // A tool that is read-only for session changes has no change record.
      || classifySessionChangeTool(tool ?? lease.scope.tool) === 'read-only') return;
    try {
      await options.recordReceipt?.({ ...lease.scope, directory: lease.directory, source: 'confined-execution', complete: true, files: [], tool });
    } catch (cause) {
      try { options.onDiagnostic?.({ event: 'session_execution', sessionID: lease.scope.sessionID, callID: lease.scope.callID,
        phase: 'cancelled_receipt', state: 'failed', code: cause?.code || 'change_receipt_failed' }); } catch { /* Observer only. */ }
    }
  };
  // Removing a published call's private view (12,000 files take about 0.8 s)
  // no longer withholds the tool result: publication is already durable, the
  // view is not read again, and cleanup is retryable work that recovery
  // finishes after a crash. Shutdown waits for the removals in flight.
  // Kill switch, read per call: DEVRYAN_DEFERRED_LEASE_CLEANUP=0.
  const cleanups = new Set();
  const cleanupAfterPublication = (lease) => {
    if (process.env.DEVRYAN_DEFERRED_LEASE_CLEANUP === '0') return timedExecutionStep('lease_cleanup', () => cleanup(lease));
    const started = Date.now();
    const work = cleanup(lease).then(() => {
      try { options.onDiagnostic?.({ event: 'session_execution', phase: 'lease_cleanup', state: 'completed', elapsedMs: Date.now() - started, deferred: true }); }
      catch { /* Observer only. */ }
    }).finally(() => cleanups.delete(work));
    cleanups.add(work);
    return undefined;
  };
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
        await recordCancelled(lease, lease.scope?.tool);
      }
      return { terminated: true, sessions: input.sessions };
    },
  };
  const rawCoordinator = createScopedRevertCoordinator({ runtime, executions, openchamberDataDir: options.dataDirectory,
    buildOpenCodeUrl: options.buildOpenCodeUrl, getOpenCodeAuthHeaders: options.getOpenCodeAuthHeaders,
    fetchImpl: options.fetchImpl, onDiagnostic: options.onDiagnostic, legacy: options.legacyChanges });
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
    if (input.action === 'direct-admit' || input.action === 'direct-finish') {
      // Kill switch: the companion falls back to the reserved-lease protocol.
      if (process.env.DEVRYAN_DIRECT_CONTROL_RECEIPTS === '0') throw failure('direct_receipts_disabled');
      if (!DIRECT_RECEIPT_TOOLS.has(input.tool) || !/^[a-f0-9]{64}$/.test(input.argsDigest ?? '')) throw failure('invalid_capture_identity', 400);
      const identity = { ...input, userMessageID: record.info.parentID, parentID: current.parentID };
      if (input.action === 'direct-admit') {
        const admitted = await executionPhase('direct_admission', () => runtime.admitDirect(identity));
        const token = randomUUID();
        directAdmissions.set(token, Date.now());
        while (directAdmissions.size > DIRECT_ADMISSIONS_MAX) directAdmissions.delete(directAdmissions.keys().next().value);
        return { ...admitted, token };
      }
      const result = await executionPhase('direct_receipt', () => runtime.finishDirect({ ...identity, executionFingerprint: input.argsDigest }));
      // Session-change evidence never covers read-only tools: history import
      // and observation skip them (session-changes-tools.js). Their empty
      // attestation only cost a second ledger transaction plus a serialized
      // session-changes commit per call, queued behind every session of the
      // project. finishDirect above remains the revert/cancellation fence.
      // Kill switch: DEVRYAN_DIRECT_LEDGER_ONLY=0 records the attestation again.
      if (process.env.DEVRYAN_DIRECT_LEDGER_ONLY !== '0' && classifySessionChangeTool(input.tool) === 'read-only') return result;
      const receipt = await executionPhase('execution_receipt', () => runtime.executionReceipt({ directory: input.directory, token: input.token }));
      await executionPhase('change_receipt', () => options.recordReceipt?.({ ...receipt, tool: input.tool }));
      return result;
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
      claimed(lease);
      if (input.kind === 'control') return { lease };
      try { return { lease, launch: await launchWatched(lease, input) }; }
      catch (cause) {
        await runtime.cancelUnstartedCall({ ...input, token: lease.token });
        await cleanup({ directory: input.directory, token: lease.token });
        throw cause;
      }
    }
    if (input.action === 'cancel-before-start') {
      // Only the trusted companion can attest that it never spawned a process.
      const lease = await executionPhase('lease_lookup', () => runtime.leaseForCall(input));
      if (lease) idleWatchdog.unwatch(lease.token);
      if (lease && preparationHost) await (await preparationHost).jobs.cancel(lease);
      await runtime.cancelUnstartedCall(input);
      if (lease) await recordCancelled(lease, input.tool);
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
      claimed(lease);
      if (input.kind === 'control') return { lease };
      try { return { lease, launch: await launchWatched(lease, input) }; }
      catch (cause) {
        await runtime.cancelUnstartedCall({ ...input, token: lease.token });
        await cleanup({ directory: input.directory, token: lease.token });
        throw cause;
      }
    }
    if (input.action !== 'finish') throw failure('invalid_capture_identity', 400);
    idleWatchdog.unwatch(lease.token);
    // Timing only (see `finish` below): these steps keep their own
    // cancellation and failure behaviour.
    const claimedAt = claims.get(lease.token);
    if (claimedAt !== undefined) { claims.delete(lease.token); executionStep('tool_execution', Date.now() - claimedAt); }
    if (lease.executionKind !== 'control') {
      const receipt = await timedExecutionStep('termination_receipt', () => readSessionExecutionReceipt(lease));
      if (receipt.cancelled || !receipt.confined) {
        await runtime.cancelLease({ directory: input.directory, token: lease.token });
        if (receipt.cancelled) await recordCancelled(lease, input.tool);
        throw failure(receipt.cancelled ? 'execution_cancelled' : 'mutation_runtime_unsupported');
      }
    }
    const result = await timedExecutionStep('publication', () => runtime.finish({ directory: input.directory, token: lease.token }));
    // A control tool that is read-only for session changes (todowrite,
    // question, webfetch, devryan_task) has nothing to attest, as in a direct
    // finish: its empty attestation cost a serialized session-changes commit
    // per call. Kill switch: DEVRYAN_CONTROL_LEDGER_ONLY=0.
    if (process.env.DEVRYAN_CONTROL_LEDGER_ONLY === '0' || lease.executionKind !== 'control'
      || classifySessionChangeTool(input.tool) !== 'read-only') {
      const receipt = await timedExecutionStep('execution_receipt', () => runtime.executionReceipt({ directory: input.directory, token: lease.token }));
      await timedExecutionStep('change_receipt', async () => options.recordReceipt?.({ ...receipt, tool: input.tool }));
    }
    await cleanupAfterPublication({ directory: input.directory, token: lease.token });
    return result;
  };
  // A finish withholds the tool result until the change is published, its
  // receipt recorded and its view removed. It is journaled like a direct
  // finish (one record with per-step time, only when slow or failed) and gains
  // no deadline. `tool_execution` is the run time between claim and finish; it
  // is not part of `elapsedMs`.
  const finish = (input) => withExecutionSummary(input, () => dispatch(input),
    { phase: 'finish', onDiagnostic: options.onDiagnostic, minMs: options.admissionSummaryMinMs ?? 250 });
  // A direct finish withholds a tool result, so its bookkeeping is journaled
  // like an admission (only when slow or failed) but gains no deadline: the
  // receipt commit must settle. `tool_execution` is the companion's run time
  // between admission and this finish; it is not part of `elapsedMs`.
  const directFinish = (input) => {
    const admittedAt = typeof input.token === 'string' ? directAdmissions.get(input.token) : undefined;
    if (admittedAt !== undefined) directAdmissions.delete(input.token);
    return withExecutionSummary(input, () => {
      if (admittedAt !== undefined) executionStep('tool_execution', Date.now() - admittedAt);
      return dispatch(input);
    }, { phase: 'direct_finish', onDiagnostic: options.onDiagnostic, minMs: options.admissionSummaryMinMs ?? 250 });
  };
  const dispatchPlugin = (input) => input.action === 'direct-finish' ? directFinish(input)
    : input.action === 'finish' ? finish(input)
    : ['admit', 'prompt', 'begin', 'child', 'cancel-before-start', 'prepare-poll', 'claim', 'direct-admit'].includes(input.action)
    // Fail after 25 s without progress (this request's own work or the lock
    // holder it queues behind), never later than 50 s: the companion's RPC
    // limit is 60 s, and deadline-free commits may run past the abort.
    ? withExecutionAdmission(input, () => executionPhase(input.action === 'cancel-before-start' ? 'cleanup' : 'host_request', () => dispatch(input)), {
      timeoutMs: options.admissionTimeoutMs ?? 50_000, idleMs: options.admissionIdleMs ?? 25_000, onDiagnostic: options.onDiagnostic,
      // Healthy host requests are frequent and fast; they are journaled only when slow or failed.
      // Baseline QA lowers the threshold to journal every request's phase summary.
      summary: { minMs: options.admissionSummaryMinMs ?? 250 },
    }) : dispatch(input);
  const plugin = (input) => activity([input.sessionID, input.parentID], () => dispatchPlugin(input));
  // Background first build of a project's ledger, so its first confined call
  // does not stall. One build at a time per host: opening another project
  // cancels the current one (committed batches are kept and resumed by the
  // next observation), and host drain cancels it. A real call arriving
  // meanwhile joins the in-flight pass. Kill switch: DEVRYAN_LEDGER_PREWARM=0.
  let ledgerWarm = null;
  const warmLedger = ({ directory } = {}) => {
    if (process.env.DEVRYAN_LEDGER_PREWARM === '0' || typeof directory !== 'string' || !path.isAbsolute(directory)) {
      return Promise.resolve({ skipped: 'disabled' });
    }
    if (ledgerWarm?.directory === directory) return ledgerWarm.work;
    ledgerWarm?.controller.abort(Object.assign(new Error('ledger_warm_superseded'), { code: 'ledger_warm_superseded' }));
    const previous = ledgerWarm?.work ?? Promise.resolve();
    const entry = { directory, controller: new AbortController() };
    entry.work = previous.then(async () => {
      entry.controller.signal.throwIfAborted();
      if (!await isConfined({ directory })) return { skipped: 'not-confined' };
      const result = await withExecutionPreparation({}, () => runtime.warm({ directory }),
        { signal: entry.controller.signal, onDiagnostic: options.onDiagnostic });
      try { options.onDiagnostic?.({ event: 'session_execution', phase: 'ledger_warm', state: 'completed', ...result }); } catch { /* Observer only. */ }
      return result;
    }).catch((cause) => ({ failed: cause?.code ?? 'ledger_warm_failed' }))
      .finally(() => { if (ledgerWarm === entry) ledgerWarm = null; });
    ledgerWarm = entry;
    return entry.work;
  };
  // Without the companion, a legacy (OpenCode snapshot) revert would bypass the
  // ownership ledger. Refuse it for any conversation the ledger owns, and while
  // any ledger transaction in the project still awaits recovery.
  const assertLegacyRevertAllowed = async ({ directory, sessionID }) => {
    if (!identity(sessionID) || !path.isAbsolute(directory ?? '')) throw failure('invalid_capture_identity', 400);
    const state = await runtime.capturedSessionState({ directory, sessionID });
    if (state.captured) throw Object.assign(new Error('This conversation\'s changes are owned by the DevRyan companion, which is unavailable. Revert and Redo stay disabled until it is restored.'),
      { code: 'mutation_history_captured', status: 409 });
    if (state.pending) throw Object.assign(new Error('An interrupted Revert in this project is waiting for the DevRyan companion to finish recovery. Restore the companion before reverting.'),
      { code: 'mutation_recovery_pending', status: 409 });
  };
  return { get retentionReady() { return retentionReady; }, runtime, executions, coordinator, plugin, isConfined, persistCursorRecord, startCursor, assertLegacyRevertAllowed, warmLedger,
    recover: async () => {
      retentionReady = false; let failed = false;
      const report = (cause) => {
        failed = true;
        try { options.onDiagnostic?.({ event: 'session_revert', phase: 'recovery_failed', code: cause.code || 'mutation_recovery_required' }); } catch { /* Observer only. */ }
      };
      // Orphaned socket directories are disposable; never a recovery failure.
      void sweepExecutionSocketDirectories().catch(() => {});
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
      idleWatchdog.stop();
      const warming = ledgerWarm;
      warming?.controller.abort(Object.assign(new Error('ledger_warm_stopped'), { code: 'ledger_warm_stopped' }));
      // A failed keeper must not prevent independent owners and I/O draining.
      const results = await Promise.allSettled([
        warming?.work,
        ...cleanups,
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
