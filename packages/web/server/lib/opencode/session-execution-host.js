import { executionSignal, checkExecutionAdmission, executionPhase, executionStep, timedExecutionStep, withExecutionAdmission, withExecutionPreparation, withExecutionSummary } from '@openchamber/harness-runtime/lib/execution-admission.js';
import { classifySessionChangeTool } from '@openchamber/harness-runtime/lib/session-changes-tools.js';
import { cleanupExecutionLease } from '@openchamber/harness-runtime/lib/execution-cleanup.js';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createSessionMutationRuntime } from '@openchamber/harness-runtime';
import { prepareSessionExecution, readSessionExecutionReceipt, verifySessionExecutionLauncher, startSessionExecution, startReadOnlySessionExecution, runReadOnlySessionExecution, sweepExecutionSocketDirectories } from '@openchamber/harness-runtime/lib/session-execution.js';
import { createScopedRevertCoordinator } from './session-revert-coordinator.js';
import { createSessionExecutionOwner } from '@openchamber/harness-runtime/lib/session-execution-owner.js';
import { CURSOR_PROVIDER_ID } from '@openchamber/cursor-sdk-runtime';
import { createExecutionHostOwner, executionHostOwnerLost, executionOwnerFactory } from '@openchamber/harness-runtime/lib/execution-host-owner.js';
import { createExecutionPreparations, recoverExecutionLeases } from './execution-preparations.js';
import { createExecutionIdleWatchdog } from '@openchamber/harness-runtime/lib/execution-idle-watchdog.js';
import { isOpenCodeNotFoundError } from './opencode-client/index.js';
import { createCapabilityAbsentError, resolveOpenCodeGeneration } from './opencode-generation.js';
import { toV1ToolName } from './v2/projection/tools.js';
import { isReviewedControllerGitArgs } from './execution-helper-policy.js';
import { executeNativeContextAssets } from './runtime-host/native-context-assets.js';
import { executeNativeInterviewDocument } from './runtime-host/native-interview-document.js';

const failure = (code, status = 409) => Object.assign(new Error(code), { code, status, statusCode: status });
// Built-in tools the companion may run with a direct receipt: audited
// read-only (companion/SEAMS.md). The companion selects them by object
// identity; the name check here is defense in depth.
const DIRECT_RECEIPT_TOOLS = new Set(['read', 'glob', 'grep', 'skill']);
const NATIVE_AST_TOOLS = new Set(['ast_grep_search', 'ast_grep_replace']);
// Admission times of direct calls, keyed by admission token, so a finish can
// journal how long the tool ran in the companion. Bounded; a call that never
// finishes (cancelled, crashed) is evicted by later admissions.
const DIRECT_ADMISSIONS_MAX = 1024;
const identity = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,512}$/.test(value);
const guardedNativeReadArgs = (tool, args) => {
  if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) throw failure('native_execution_input_invalid', 400);
  const separator = args.indexOf('--');
  const flags = separator < 0 ? args.slice(0, -1) : args.slice(0, separator);
  // Native glob can request following directory symlinks. Its traversal has
  // no per-entry canonical authorization, so retain the closed default.
  if (flags.includes('--follow') || flags.includes('-L')) throw failure('native_read_follow_denied', 403);
  const reviewedFlags = tool === 'glob' ? new Set(['--no-config', '--files', '--hidden'])
    : new Set(['--no-config', '--json', '--hidden', '--no-messages', '--fixed-strings', '--ignore-case']);
  if (flags.some(flag => !reviewedFlags.has(flag) && !flag.startsWith('--glob='))) throw failure('native_read_arguments_denied', 403);
  if (!flags.includes('--no-config') || (tool === 'glob' && (separator >= 0 || args.at(-1) !== '.' || !flags.includes('--files')))
    || (tool === 'grep' && (separator < 0 || args.length !== separator + 3 || !flags.includes('--json')))) {
    throw failure('native_read_arguments_denied', 403);
  }
  // Ripgrep globs use last-match precedence. Put mandatory exclusions after
  // native/user include globs, but before positional operands or `--`.
  const index = separator < 0 ? args.length - 1 : separator;
  // Closed B policy: rg must not read implicit ignore inputs (including their
  // symlink targets). --no-ignore implies all dot/exclude/global/parent/VCS
  // ignore-file closures; explicit --ignore-file flags are rejected above.
  return [...args.slice(0, index), '--no-ignore', '--iglob=!**/.git', '--iglob=!**/.git/**', ...args.slice(index)];
};
const nativePublicationResult = (result, publication, lease, tool) => {
  if(result&&tool==='gpt_imagegen'){
    const canonical=value=>typeof value==='string'?value.split(lease.viewDirectory).join(lease.projectDirectory):value;
    result={...result,output:canonical(result.output),metadata:{...result.metadata,out:canonical(result.metadata?.out)}};
  }
  if (result && tool === 'devryan_browser') {
    const paths = (publication?.files ?? []).filter(file => file.status !== 'deleted'
      && typeof file.path === 'string' && !path.isAbsolute(file.path) && !file.path.split(/[\\/]/).includes('..'))
      .map(file => path.join(lease.projectDirectory, file.path));
    if (paths.length) {
      const artifacts = paths.slice(0, 100);
      const notice = `Published browser files: ${artifacts.join(', ')}${paths.length > artifacts.length ? ` (${paths.length - artifacts.length} more)` : ''}.`;
      result = { ...result, content: Array.isArray(result.content) ? [...result.content, { type: 'text', text: notice }]
        : `${result.content ?? ''}\n\n${notice}`, metadata: { ...result.metadata, browserArtifacts: artifacts } };
    }
  }
  if (!result || publication?.outcome !== 'partial') return result;
  const notice = `Some changes were not published because these files changed during execution: ${(publication.conflicts ?? []).map(item => item.path).join(', ')}. Proposed contents were retained for recovery.`;
  return { ...result, content: Array.isArray(result.content) ? [...result.content, { type: 'text', text: notice }]
    : `${result.content ?? ''}\n\n${notice}`, metadata: { ...result.metadata,
      publication: { outcome: 'partial', conflicts: publication.conflicts ?? [] } } };
};

/** Private bridge for the pinned companion. Its bearer credential belongs to
 * the model/control process and must never enter a confined tool's environment.
 * Every writer, including a failed command, needs a native termination receipt
 * before publication. Legacy observations never become ownership evidence.
 *
 * Generation 2 reads use canonical native-sequence ownership projected by the
 * generation client. Native execution shares this host's ledger and launcher;
 * confinement is advertised only after its explicitly injected host is ready.
 * Cursor execution requires its constructor-owned native authority.
 */
export function createSessionExecutionHost(options) {
  const runtime = createSessionMutationRuntime({ directory: path.join(options.dataDirectory, 'harness', 'session-mutations'),
    onMaterialize: options.onMaterialize,
    // Ledger maintenance and input-classification failures reach the journal.
    onDiagnostic: (record) => { try { options.onDiagnostic?.({ event: 'session_execution', ...record }); } catch { /* Observer only. */ } } });
  const generation = () => resolveOpenCodeGeneration(options.openCodeClient);
  const requestSignal = () => AbortSignal.any([AbortSignal.timeout(30_000), ...(executionSignal() ? [executionSignal()] : [])]);
  // Gen 2 reads keep the gen-1 failure codes.
  const clientRead = async (read) => {
    try {
      return await read({ signal: requestSignal() });
    } catch (cause) {
      throw Object.assign(failure(isOpenCodeNotFoundError(cause) ? 'mutation_history_unavailable' : 'mutation_runtime_unavailable'), { cause });
    }
  };
  const readSession = (sessionID, directory) => {
    generation();
    return clientRead((read) => options.openCodeClient.sessions.get(sessionID, { ...read, directory }));
  };
  const readMessage = (sessionID, messageID, directory) => {
    generation();
    return clientRead((read) => options.openCodeClient.sessions.message(sessionID, messageID, { ...read, directory }));
  };
  const session = async (input) => {
    if (!identity(input.sessionID) || !path.isAbsolute(input.directory ?? '')) throw failure('invalid_capture_identity', 400);
    const info = await readSession(input.sessionID, input.directory);
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
  // These handles own supervised process lifetimes, not another ledger. The
  // existing mutation runtime owns admission, leases, receipts and publication.
  const nativeHandles = new Map();
  // The original image hook has small presentation maps. A location mutex
  // preserves their order across private workers; process/lease scheduling
  // remains entirely with the existing execution owner.
  const contextImageStates = new Map(), contextAssetWorks = new Set();
  let contextAssetLifetime = new AbortController();
  let controllerSettlement, terminalDrain, terminal = false;
  const nativeAdmissions = new Set(), unsettledAdmissions = new Set();
  const acquireController = action => {
    const lifetime = contextAssetLifetime, signal = lifetime.signal;
    signal.throwIfAborted();
    const work = Promise.resolve().then(() => { signal.throwIfAborted(); return action(signal); }).catch(cause => {
      if (cause?.nativeProcessUnsettled || ['mutation_termination_unconfirmed', 'execution_owner_termination_unconfirmed'].includes(cause?.code)) {
        unsettledAdmissions.add(cause); lifetime.abort(failure('execution_cancelled'));
      }
      throw cause;
    });
    nativeAdmissions.add(work);
    void work.finally(() => nativeAdmissions.delete(work)).catch(() => {});
    return work;
  };
  const nativeOptions = options.nativeExecution;
  const nativeRecheck = async (input) => {
    if (!nativeOptions || typeof nativeOptions.recheckPermit !== 'function') throw failure('native_execution_authority_unavailable', 503);
    await nativeOptions.recheckPermit(input);
  };
  // A replacement owns a new acquisition lifetime only after the old keeper,
  // workers, publication and callbacks have settled. Final drain never reopens it.
  const settleOwnedExecutions = async () => {
    // Admission may be awaiting canonical reads before a handle exists. Abort
    // its captured lifetime and join it before taking the process snapshot.
    await Promise.allSettled([...nativeAdmissions]);
    const warming = ledgerWarm;
    warming?.controller.abort(Object.assign(new Error('ledger_warm_stopped'), { code: 'ledger_warm_stopped' }));
    const results = await Promise.allSettled([
      ...[...nativeHandles.values()].map(job => { job.controller.abort(failure('execution_cancelled')); return job.settled; }),
      ...[...contextAssetWorks].map(work => work.catch(cause => { if (cause?.nativeProcessUnsettled) throw cause; })),
      warming?.work,
      ...[...cursorOwners.values()].map(owner => owner.drain()),
    ]);
    const queued = await runtime.drain();
    // A paused context acquisition can still be awaiting canonical capture.
    // Join it before selecting/closing the keeper so it cannot create an
    // unobserved preparation owner after the settlement snapshot.
    const preparationsSettled = await Promise.allSettled([
      ...cleanups,
      preparationHost?.then(async host => {
        try { return await host.jobs.drain(); } finally { await host.owner.close(); }
      }, cause => { if (cause?.code === 'execution_owner_termination_unconfirmed') throw cause; }),
      ...retiredPreparations,
    ]);
    const failures = [...unsettledAdmissions];
    const collect = rows => {
      for (const result of rows ?? []) {
        if (result?.status === 'rejected') failures.push(result.reason);
        else if (result?.status === 'fulfilled' && Array.isArray(result.value)) collect(result.value);
      }
    };
    collect(results); collect(queued); collect(preparationsSettled);
    const unique = [...new Set(failures)];
    if (unique.length === 1) throw unique[0];
    if (unique.length) throw new AggregateError(unique, 'Execution settlement failed');
  };
  const settleController = () => {
    if (terminal) return terminalDrain;
    if (controllerSettlement) return controllerSettlement;
    const previous = contextAssetLifetime;
    previous.abort(failure('execution_cancelled'));
    controllerSettlement = settleOwnedExecutions().then(() => {
      if (!terminal) contextAssetLifetime = new AbortController();
      controllerSettlement = undefined;
    });
    // Failed settlement retains the aborted lifetime and its failure fence.
    void controllerSettlement.catch(() => {});
    return controllerSettlement;
  };
  const drain = () => {
    terminal = true; idleWatchdog.stop(); contextAssetLifetime.abort(failure('execution_cancelled'));
    return terminalDrain ??= (async () => {
      const failures = [];
      try { await controllerSettlement; } catch (cause) { failures.push(cause); }
      try { await settleOwnedExecutions(); } catch (cause) { failures.push(cause); }
      const unique = [...new Set(failures)];
      if (unique.length === 1) throw unique[0];
      if (unique.length) throw new AggregateError(unique, 'Final execution settlement failed');
    })();
  };
  const nativeEvent = (job, event, terminal = false) => {
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (!terminal && (job.bytes + bytes > (nativeOptions.maxEventBytes ?? 1024 * 1024) || job.events.length >= 512)) {
      job.failure ??= failure('native_execution_event_overflow', 503);
      job.controller.abort(job.failure);
      return;
    }
    job.events.push({ cursor: ++job.cursor, ...event }); job.bytes += bytes;
    for (const wake of job.waiters) wake(); job.waiters.clear();
  };
  const executeNativeExecution = async (input, { signal } = {}) => {
    options.assertExecutionReady?.();
    if (input.action === 'context-assets') {
      const scope = { ...input }; delete scope.action;
      return nativeContextAssets(scope, { signal });
    }
    if (input.action === 'helper') {
      if (nativeHandles.size >= 128) throw failure('native_execution_capacity_exceeded', 503);
      if (!nativeOptions || !['git', 'git.exe'].includes(path.basename(input.command ?? '')) || !Array.isArray(input.args)) throw failure('native_helper_denied', 403);
      if (!isReviewedControllerGitArgs(input.args)) throw failure('native_helper_denied', 403);
      if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 10_000)) throw failure('native_helper_timeout_invalid', 400);
      if (!path.isAbsolute(input.cwd ?? '') || !Array.isArray(nativeOptions.helperRoots)) throw failure('native_helper_directory_denied', 403);
      const cwd = await fs.realpath(input.cwd);
      const roots = await Promise.all(nativeOptions.helperRoots.map((root) => fs.realpath(root)));
      if (!roots.some((root) => cwd === root || cwd.startsWith(`${root}${path.sep}`))) throw failure('native_helper_directory_denied', 403);
      const command = nativeOptions.gitCommand ?? '/usr/bin/git';
      if (!path.isAbsolute(command) || !await verifySessionExecutionLauncher({ launcher: launcher() })) throw failure('mutation_runtime_unsupported');
      signal?.throwIfAborted();
      const controller = new AbortController(), handle = randomUUID();
      const job = { input, controller, done: false, cursor: 0, acknowledged: 0 };
      nativeHandles.set(handle, job);
      job.settled = runReadOnlySessionExecution({ launcher: launcher(), storage: path.join(options.dataDirectory, 'harness', 'native-helpers'),
        logicalDirectory: cwd, command, args: ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', ...input.args],
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(input.timeoutMs ?? 10_000), ...(signal ? [signal] : [])]),
        socketDirectory: nativeOptions.socketDirectory, workerBrowsers: false, deniedReadDirectories: nativeOptions.deniedReadDirectories,
        maxOutputBytes: input.maxOutputBytes ?? 1024 * 1024, maxErrorBytes: input.maxErrorBytes ?? 64 * 1024,
        onTermination: (receipt) => { try { nativeOptions.onTermination?.({ helper: true, command: input.args[0], receipt }); } catch { /* Observer only. */ } },
      }).finally(() => { job.done = true; nativeHandles.delete(handle); });
      const result = await job.settled;
      return { exitCode: result.receipt.exitCode, receipt: result.receipt,
        stdout: result.stdout.toString('base64'), stderr: result.stderr.toString('base64') };
    }
    if (input.action === 'cancel-sessions') {
      if (!Array.isArray(input.sessions) || input.sessions.some((id) => !identity(id))) throw failure('invalid_capture_identity', 400);
      const selected = [...nativeHandles.values()].filter((job) => input.sessions.includes(job.input.sessionID));
      for (const job of selected) job.controller.abort(failure('execution_cancelled'));
      await Promise.all(selected.map((job) => job.settled));
      // This attests only supervised processes. The caller separately owns
      // native runner interruption and may not infer it from an empty map.
      return { processesTerminated: true, sessions: input.sessions };
    }
    if (input.action === 'bind-shell-job') {
      await nativeRecheck(input);
      const job = nativeHandles.get(input.handle);
      if (!job || job.input.kind !== 'shell' || !identity(input.jobID)
        || input.tool !== 'shell' || input.command !== job.input.args?.at(-1)
        || ['directory', 'sessionID', 'messageID', 'callID'].some(key => input[key] !== job.input[key])) throw failure('native_shell_job_identity_mismatch', 403);
      const binding = await runtime.bindNativeShellJob({ ...input, token: job.lease.token });
      job.bindingPending = false;
      return binding;
    }
    if (input.action === 'direct-admit' || input.action === 'direct-finish') {
      await nativeRecheck(input);
      if (generation() !== 2) throw failure('native_execution_generation_mismatch');
      signal?.throwIfAborted();
      return dispatch(input, async () => { await nativeRecheck(input); signal?.throwIfAborted(); });
    }
    if (input.action === 'control-begin' || input.action === 'control-finish') {
      const origin = input.authorization?.input?.provenance;
      const mcp = origin?.kind === 'native' && origin.id === 'devryan.remote-mcp'
        && input.authorization.input.nativeToolID === input.tool;
      const slim = nativeOptions.reviewedAstOrigin;
      const webfetch = input.tool === 'webfetch' && input.authorization?.input?.toolID === 'webfetch'
        && !Object.hasOwn(input.authorization.input, 'nativeToolID') && slim?.kind === 'plugin' && slim.id === 'devryan.slim'
        && slim.capabilities.includes('network') && origin?.kind === slim.kind && origin.id === slim.id
        && origin.manifestDigest === slim.manifestDigest && JSON.stringify(origin.capabilities) === JSON.stringify(slim.capabilities);
      const reviewedDocument = nativeOptions.reviewedDocumentOrigin;
      const document = input.tool === 'devryan_document' && input.authorization?.input?.toolID === 'devryan_document'
        && !Object.hasOwn(input.authorization.input, 'nativeToolID') && reviewedDocument?.kind === 'plugin'
        && reviewedDocument.id === 'devryan.document-reader' && origin?.kind === reviewedDocument.kind
        && origin.id === reviewedDocument.id && origin.manifestDigest === reviewedDocument.manifestDigest
        && JSON.stringify(origin.capabilities) === JSON.stringify(reviewedDocument.capabilities);
      if (!mcp && !webfetch && !document) throw failure('native_control_origin_denied', 403);
      return nativeControl({ action: input.action === 'control-begin' ? 'begin' : 'finish', invocation: input, token: input.token }, signal);
    }
    if (input.action !== 'start') {
      const job = nativeHandles.get(input.handle);
      if (!job) throw failure('native_execution_handle_unknown', 404);
      if (input.action === 'cancel') {
        job.controller.abort(failure('execution_cancelled'));
        await job.settled; // Missing receipts reject, never become acknowledgements.
        return { terminated: true };
      }
      if (input.action === 'input') {
        if (!job.child || !job.permissions.delete(input.reply?.id) || typeof input.reply?.ok !== 'boolean') throw failure('native_execution_input_invalid', 400);
        const line = JSON.stringify(input.reply);
        if (Buffer.byteLength(line) > 64 * 1024) throw failure('native_execution_input_too_large', 413);
        await new Promise((resolve, reject) => job.child.stdin.write(`${line}\n`, (cause) => cause ? reject(cause) : resolve()));
        return { accepted: true };
      }
      if (input.action !== 'read' || !Number.isSafeInteger(input.cursor) || input.cursor < job.acknowledged || input.cursor > job.cursor) throw failure('native_execution_cursor_invalid', 400);
      // A cursor acknowledges only events previously delivered to this reader.
      if (input.cursor > job.delivered) throw failure('native_execution_cursor_invalid', 400);
      job.acknowledged = input.cursor;
      job.events = job.events.filter((event) => event.cursor > input.cursor);
      job.bytes = job.events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0);
      signal?.throwIfAborted();
      if (!job.events.length && !job.done) {
        await new Promise((resolve, reject) => {
          const wake = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); job.waiters.delete(wake); resolve(); };
          const abort = () => { wake(); reject(signal.reason); };
          const timer = setTimeout(wake, 15_000);
          job.waiters.add(wake); signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
        });
      }
      const events = job.events.slice(0, 64);
      job.delivered = Math.max(job.delivered, events.at(-1)?.cursor ?? input.cursor);
      return { events, cursor: job.delivered, done: job.done };
    }
    await nativeRecheck(input);
    if (!['writer', 'shell', 'read'].includes(input.kind) || !identity(input.agent)) throw failure('native_execution_input_invalid', 400);
    const ast = input.kind === 'writer' && NATIVE_AST_TOOLS.has(input.tool);
    const browser=input.kind==='writer'&&input.tool==='devryan_browser';
    const imagegen=input.kind==='writer'&&input.tool==='gpt_imagegen';
    if(imagegen){
      const origin=input.authorization?.input?.provenance,expected=nativeOptions.reviewedImagegenOrigin;
      if(!expected||expected.kind!=='plugin'||expected.id!=='opencode-gpt-imagegen'||origin?.kind!==expected.kind||origin.id!==expected.id
        ||origin.manifestDigest!==expected.manifestDigest||JSON.stringify(origin.capabilities)!==JSON.stringify(expected.capabilities))throw failure('native_imagegen_registration_required',403);
      if(typeof nativeOptions.imageGeneration!=='function')throw failure('native_imagegen_owner_unavailable',503);
    }
    let reviewedBrowser;
    if(browser){
      const origin=input.authorization?.input?.provenance,expected=nativeOptions.reviewedBrowserOrigin;
      if(!expected||expected.kind!=='plugin'||expected.id!=='devryan.browser'||origin?.kind!==expected.kind||origin.id!==expected.id
        ||origin.manifestDigest!==expected.manifestDigest||JSON.stringify(origin.capabilities)!==JSON.stringify(expected.capabilities))throw failure('native_browser_registration_required',403);
      if(typeof nativeOptions.getReviewedBrowser!=='function'||typeof nativeOptions.browserOperation!=='function')throw failure('native_browser_owner_unavailable',503);
      if(['reviewedBrowser','browserSocketDirectory','userMessageID'].some(key=>Object.hasOwn(input,key)))throw failure('native_browser_caller_asset_denied',403);
      reviewedBrowser=structuredClone(await nativeOptions.getReviewedBrowser());
      const validAsset=async(file,digest,executable)=>{
        if(!path.isAbsolute(file??'')||file.includes('\0')||!/^[a-f0-9]{64}$/.test(digest??'')||await fs.realpath(file)!==file)throw failure('native_browser_asset_invalid',403);
        const stat=await fs.lstat(file);if(!stat.isFile()||stat.size>256*1024*1024||(executable&&!(stat.mode&0o111))
          ||createHash('sha256').update(await fs.readFile(file)).digest('hex')!==digest)throw failure('native_browser_asset_invalid',403);
      };
      if(!reviewedBrowser||Object.keys(reviewedBrowser).some(key=>!['binaryPath','sha256','configPath','configSha256','ffmpeg'].includes(key)))throw failure('native_browser_asset_invalid',403);
      await validAsset(reviewedBrowser.binaryPath,reviewedBrowser.sha256,true);await validAsset(reviewedBrowser.configPath,reviewedBrowser.configSha256,false);
      if(reviewedBrowser.ffmpeg){if(Object.keys(reviewedBrowser.ffmpeg).some(key=>!['path','sha256'].includes(key)))throw failure('native_browser_asset_invalid',403);
        await validAsset(reviewedBrowser.ffmpeg.path,reviewedBrowser.ffmpeg.sha256,true);}
      await nativeRecheck(input);
    }
    if (ast) {
      const origin = input.authorization?.input?.provenance, expected = nativeOptions.reviewedAstOrigin;
      if (!expected || expected.kind !== 'plugin' || expected.id !== 'devryan.slim' || origin?.kind !== expected.kind
        || origin.id !== expected.id || origin.manifestDigest !== expected.manifestDigest
        || JSON.stringify(origin.capabilities) !== JSON.stringify(expected.capabilities)) throw failure('native_ast_registration_required', 403);
      if (!nativeOptions.reviewedAst) throw failure('native_ast_asset_unavailable', 503);
    }
    if (input.kind === 'writer' && !ast && !browser && !imagegen && !['write', 'edit', 'patch'].includes(input.tool)) throw failure('native_execution_input_invalid', 400);
    if (input.kind === 'read' && (!['glob', 'grep'].includes(input.tool) || !['rg', 'rg.exe'].includes(path.basename(input.command ?? '')))) throw failure('native_execution_input_invalid', 400);
    if (input.kind === 'writer' && (!path.isAbsolute(nativeOptions.workerCommand ?? '') || !Array.isArray(nativeOptions.workerArgs))) throw failure('native_writer_unavailable', 503);
    const current = await session(input);
    const record = await readMessage(input.sessionID, input.messageID, input.directory);
    const call = record?.parts?.find((part) => part.type === 'tool' && part.callID === input.callID);
    if (generation() !== 2 || record?.info?.role !== 'assistant' || record.info.sessionID !== input.sessionID
      || !call || call.tool !== toV1ToolName(input.tool) || record.turnOwnership?.source !== 'native-sequence'
      || record.turnOwnership.userMessageID !== record.info.parentID) throw failure('capture_identity_mismatch');
    if (!await verifySessionExecutionLauncher({ launcher: launcher() })) throw failure('mutation_runtime_unsupported');
    const specification = input.kind === 'writer' ? { kind: input.kind, tool: input.tool, input: input.input }
      : { kind: input.kind, command: input.command, args: input.args, env: input.env, cwd: input.cwd };
    const fingerprint = createHash('sha256').update(JSON.stringify(specification)).digest('hex');
    if (input.argsDigest !== fingerprint) throw failure('capture_identity_mismatch');
    // Never evict a running process or undelivered terminal event.
    for (const [id, job] of nativeHandles) if (job.done && !job.bindingPending && job.acknowledged === job.cursor) nativeHandles.delete(id);
    if (nativeHandles.size >= 128) throw failure('native_execution_capacity_exceeded', 503);
    if (input.kind === 'read') {
      const readDirectory = await fs.realpath(input.cwd ?? input.directory);
      const location = nativeOptions.locations?.find(location => location.directory === input.directory);
      if (nativeOptions.locations && !location) throw failure('native_read_root_denied', 403);
      const readRoots = await Promise.all((location?.readRoots ?? nativeOptions.readRoots ?? [input.directory]).map(root => fs.realpath(root)));
      const protectedRoots = await Promise.all((location?.protectedRoots ?? nativeOptions.protectedRoots ?? []).map(root => fs.realpath(root)));
      const within = (root) => readDirectory === root || readDirectory.startsWith(`${root}${path.sep}`);
      const containsProtected = protectedRoots.some(root => root.startsWith(`${readDirectory}${path.sep}`));
      if (readDirectory.split(path.sep).some(component => component.toLowerCase() === '.git') || !readRoots.some(within) || protectedRoots.some(within) || containsProtected) throw failure('native_read_root_denied', 403);
      const readArgs = guardedNativeReadArgs(input.tool, input.args);
      const controller = new AbortController();
      const job = { input, controller, events: [], cursor: 0, acknowledged: 0, delivered: 0, bytes: 0,
        waiters: new Set(), permissions: new Set(), done: false, child: null, failure: null };
      signal?.throwIfAborted();
      const handle = randomUUID(); nativeHandles.set(handle, job);
      job.settled = (async () => {
        await nativeRecheck(input); signal?.throwIfAborted();
        const env = { ...nativeOptions.workerEnvironment, ...input.env };
        for (const key of Object.keys(env)) if (/TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|AUTHORIZATION|^DEVRYAN_.*URL/i.test(key)) delete env[key];
        const started = await startReadOnlySessionExecution({ launcher: launcher(), storage: path.join(options.dataDirectory, 'harness', 'native-readers'),
          logicalDirectory: readDirectory, command: input.command, args: readArgs, env,
          socketDirectory: nativeOptions.socketDirectory, workerBrowsers: false, deniedReadDirectories: nativeOptions.deniedReadDirectories, signal: AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]),
          onOutput: ({ stream, data }) => nativeEvent(job, { type: 'output', stream, data: data.toString('base64') }) });
        job.child = started.child; nativeEvent(job, { type: 'started', pid: started.pid });
        const receipt = await started.result;
        try { nativeOptions.onTermination?.({ sessionID: input.sessionID, messageID: input.messageID, callID: input.callID, receipt }); } catch { /* Observer only. */ }
        nativeEvent(job, { type: 'settled', ok: receipt.confined && !receipt.cancelled && !job.failure,
          receipt, ...(job.failure ? { error: { message: job.failure.message } } : {}) }, true);
      })().finally(() => { job.done = true; for (const wake of job.waiters) wake(); job.waiters.clear(); });
      void job.settled.catch((cause) => { nativeEvent(job, { type: 'uncertain', error: { code: cause.code ?? 'mutation_termination_unconfirmed' } }, true); });
      return { handle };
    }
    const { owner, jobs } = await preparations(); owner.assert(); signal?.throwIfAborted();
    const lease = await runtime.reserve({ ...input, kind: 'process', userMessageID: record.info.parentID,
      parentID: current.parentID, executionFingerprint: fingerprint, ownerID: owner.id });
    if (lease.ownerID !== owner.id || lease.executionKind || lease.state === 'published') throw failure('execution_already_started');
    const job = { input, lease, controller: new AbortController(), events: [], cursor: 0, acknowledged: 0,
      delivered: 0, bytes: 0, waiters: new Set(), permissions: new Set(), done: false, child: null, failure: null, result: null,
      bindingPending: input.kind === 'shell', browserOperations:new Set(), browserIDs:new Set() };
    job.childReady=new Promise(resolve=>{job.resolveChild=resolve;});
    const handleID = randomUUID(); nativeHandles.set(handleID, job);
    job.settled = (async () => {
      const abort = () => job.controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      let launched = false, published = false;
      try {
        job.controller.signal.throwIfAborted();
        jobs.start(lease, input);
        let prepared;
        do { prepared = await jobs.poll(lease); job.controller.signal.throwIfAborted(); }
        while (prepared.state === 'preparing');
        if (prepared.state !== 'ready') throw failure(prepared.error?.code ?? 'execution_not_ready');
        job.lease = prepared.lease;
        await nativeRecheck(input); owner.assert();
        await jobs.claim(job.lease, () => runtime.claimLease({ directory: input.directory, token: lease.token, kind: 'process' }));
        const scratch = path.join(path.dirname(job.lease.viewDirectory), 'scratch');
        const env = { ...nativeOptions.workerEnvironment, ...(input.kind === 'shell' ? input.env : {}), HOME: scratch,
          XDG_CONFIG_HOME: path.join(scratch, 'config'), XDG_DATA_HOME: path.join(scratch, 'data'),
          XDG_STATE_HOME: path.join(scratch, 'state'), XDG_CACHE_HOME: path.join(scratch, 'cache') };
        for (const key of Object.keys(env)) if (/^(?:DEVRYAN_.*(?:TOKEN|URL)|OPENCODE_SERVER_(?:PASSWORD|USERNAME)|OPENCODE_AUTH_CONTENT)$|(?:TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|AUTHORIZATION)/i.test(key)) delete env[key];
        const workerInput = input.kind === 'writer' ? JSON.stringify({ protocol: 1, tool: input.tool, input: input.input,
          ...(ast ? { reviewedAst: nativeOptions.reviewedAst } : {}),...(browser?{reviewedBrowser,browserSocketDirectory:path.join(scratch,'s')}:{}),
          directory: job.lease.workingDirectory, projectDirectory: job.lease.viewDirectory,
          logicalDirectory: input.directory, logicalProjectDirectory: job.lease.projectDirectory, scratchDirectory: scratch,
          // The worker needs formatter behavior, never controller providers,
          // credentials, hooks, agents or plugin configuration.
          config: { formatter: (nativeOptions.getWriterConfig?.(input.directory) ?? nativeOptions.writerConfig)?.formatter ?? false }, context: { sessionID: input.sessionID, agent: input.agent,
            messageID: input.messageID, id: input.callID,...(browser?{userMessageID:record.info.parentID}:{}) } }) + '\n' : undefined;
        let pending = ''; const decoder = new StringDecoder('utf8');
        const onOutput = ({ stream, data }) => {
          if (input.kind === 'shell' || stream === 'stderr') { nativeEvent(job, { type: 'output', stream, data: data.toString('base64') }); return; }
          pending += decoder.write(data);
          if (Buffer.byteLength(pending) > 1024 * 1024) { job.failure ??= failure('native_worker_protocol_overflow'); job.controller.abort(job.failure); return; }
          let newline;
          while ((newline = pending.indexOf('\n')) !== -1) {
            const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
            try {
              const event = JSON.parse(line);
              if(event.type==='image-generation'){
                if(!imagegen||job.result||job.imageRequested||!identity(event.id)||Object.keys(event).some(key=>!['type','id'].includes(key)))throw failure('native_imagegen_protocol_invalid',403);
                job.imageRequested=true;
                const operation=(async()=>{
                  let reply;
                  try{
                    await nativeRecheck(input);job.controller.signal.throwIfAborted();
                    const requestPath=path.join(scratch,'image-request.json'),resultPath=path.join(scratch,'image-result.json'),limit=32*1024*1024;
                    if(await fs.realpath(requestPath)!==requestPath)throw failure('native_imagegen_protocol_invalid',403);
                    const file=await fs.open(requestPath,fsConstants.O_RDONLY|fsConstants.O_NOFOLLOW);let payload;
                    try{
                      const before=await file.stat();if(!before.isFile()||before.size>limit||(before.mode&0o077)!==0)throw failure('native_imagegen_protocol_invalid',403);
                      const bytes=await file.readFile(),after=await file.stat();
                      if(bytes.length!==before.size||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw failure('native_imagegen_protocol_invalid',403);
                      payload=JSON.parse(bytes.toString('utf8'));
                    }finally{await file.close();}
                    const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
                    if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(key=>!['input','referenceImages'].includes(key))
                      ||JSON.stringify(stable(payload.input))!==JSON.stringify(stable(input.input))||!Array.isArray(payload.referenceImages)
                      ||payload.referenceImages.length!==(input.input?.images?.length??0)
                      ||payload.referenceImages.some(value=>typeof value!=='string'||value.length>limit||!/^data:image\/[A-Za-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)))throw failure('native_imagegen_protocol_invalid',403);
                    const args=input.input;
                    if(!args||typeof args!=='object'||typeof args.prompt!=='string'||!['low','medium','high','auto'].includes(args.quality)
                      ||(args.size!==undefined&&typeof args.size!=='string'))throw failure('native_imagegen_protocol_invalid',403);
                    await nativeRecheck(input);job.controller.signal.throwIfAborted();
                    const result=await nativeOptions.imageGeneration({...input,userMessageID:record.info.parentID,token:job.lease.token},
                      {prompt:args.prompt,quality:args.quality,...(args.size===undefined?{}:{size:args.size}),referenceImages:payload.referenceImages},{signal:job.controller.signal});
                    await nativeRecheck(input);job.controller.signal.throwIfAborted();
                    if(!result||Object.keys(result).join(',')!=='base64'||typeof result.base64!=='string'||!result.base64||result.base64.length>limit
                      ||result.base64.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(result.base64)||Buffer.from(result.base64,'base64').toString('base64')!==result.base64)throw failure('native_imagegen_result_invalid',403);
                    const bytes=JSON.stringify(result);if(Buffer.byteLength(bytes)>limit)throw failure('native_imagegen_result_invalid',403);
                    await fs.writeFile(resultPath,bytes,{flag:'wx',mode:0o600});reply={type:'image-generation',id:event.id,ok:true};
                  }catch(error){
                    const code=typeof error?.code==='string'&&/^[A-Za-z0-9_.-]{1,128}$/.test(error.code)?error.code:'native_imagegen_operation_failed';
                    reply={type:'image-generation',id:event.id,ok:false,error:code};
                  }
                  await job.childReady;if(!job.child||job.child.stdin.destroyed)throw failure('native_imagegen_worker_closed',403);
                  await new Promise((resolve,reject)=>job.child.stdin.write(JSON.stringify(reply)+'\n',error=>error?reject(error):resolve()));
                })();
                job.browserOperations.add(operation);
                void operation.then(()=>job.browserOperations.delete(operation),error=>{job.browserOperations.delete(operation);job.failure??=error;job.controller.abort(error);});
              }else if(event.type==='browser'){
                const scope=event.scope;
                if(!browser||job.result||!identity(event.id)||job.browserIDs.has(event.id)||job.browserOperations.size>=32||job.browserIDs.size>=1024
                  ||Object.keys(event).some(key=>!['type','id','operation','scope','leaseID'].includes(key))
                  ||!['assert-current','resolve','acquire','touch','release'].includes(event.operation)||!scope||typeof scope!=='object'||Array.isArray(scope)
                  ||Object.keys(scope).some(key=>!['opencodeSessionID','messageID','directory','agent'].includes(key))
                  ||scope.opencodeSessionID!==input.sessionID||scope.messageID!==record.info.parentID||scope.directory!==input.directory||scope.agent!==input.agent
                  ||(['touch','release'].includes(event.operation)?!identity(event.leaseID):event.leaseID!==undefined))throw failure('native_browser_protocol_invalid',403);
                job.browserIDs.add(event.id);
                const operation=(async()=>{
                  let reply;
                  try{
                    await nativeRecheck(input);job.controller.signal.throwIfAborted();
                    const result=await nativeOptions.browserOperation({...input,userMessageID:record.info.parentID,token:lease.token},event,{signal:job.controller.signal});
                    await nativeRecheck(input);job.controller.signal.throwIfAborted();reply={type:'browser',id:event.id,ok:true,result};
                  }catch(error){
                    const code=typeof error?.code==='string'&&/^[A-Za-z0-9_.-]{1,128}$/.test(error.code)?error.code:'native_browser_operation_failed';
                    reply={type:'browser',id:event.id,ok:false,error:code};
                  }
                  const line=JSON.stringify(reply);if(Buffer.byteLength(line)>64*1024)throw failure('native_browser_reply_too_large',413);
                  await job.childReady;if(!job.child||job.child.stdin.destroyed)throw failure('native_browser_worker_closed',403);
                  await new Promise((resolve,reject)=>job.child.stdin.write(line+'\n',error=>error?reject(error):resolve()));
                })();
                job.browserOperations.add(operation);
                void operation.then(()=>job.browserOperations.delete(operation),error=>{job.browserOperations.delete(operation);job.failure??=error;job.controller.abort(error);});
              }else if (event.type === 'result') {
                if (job.result || typeof event.ok !== 'boolean') throw failure('native_worker_protocol_invalid');
                job.result = event;
              } else if (event.type === 'permission' && identity(event.id) && event.input && typeof event.input === 'object') {
                if (job.permissions.has(event.id)) throw failure('native_worker_protocol_invalid');
                const logical = (value) => typeof value === 'string' && (value === job.lease.viewDirectory || value.startsWith(`${job.lease.viewDirectory}${path.sep}`))
                  ? path.join(job.lease.projectDirectory, path.relative(job.lease.viewDirectory, value)) : value;
                event.input.resources = event.input.resources?.map(logical);
                if (event.input.save) event.input.save = event.input.save.map(logical);
                job.permissions.add(event.id); nativeEvent(job, event);
              } else if (event.type === 'progress' && event.update && typeof event.update === 'object') nativeEvent(job, event);
              else throw failure('native_worker_protocol_invalid');
            } catch (cause) { job.failure ??= cause; job.controller.abort(cause); }
          }
        };
        let executionLease = job.lease;
        if (input.kind === 'shell' && input.cwd) {
          const relative = path.relative(job.lease.projectDirectory, input.cwd);
          if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw failure('invalid_execution_path');
          executionLease = { ...job.lease, workingDirectory: path.join(job.lease.viewDirectory, relative) };
        }
        const started = await startSessionExecution({ launcher: launcher(), lease: executionLease,
          command: input.kind === 'writer' ? nativeOptions.workerCommand : input.command,
          args: input.kind === 'writer' ? nativeOptions.workerArgs : input.args,
          env, signal: AbortSignal.any([owner.signal, job.controller.signal]), onOutput,
          input: workerInput, interactive: input.kind === 'writer', socketDirectory: browser ? path.join(scratch,'s') : nativeOptions.socketDirectory,
          workerBrowsers: nativeOptions.workerBrowsers ?? false, deniedReadDirectories: nativeOptions.deniedReadDirectories });
        launched = true; job.child = started.child;job.resolveChild();
        if (workerInput) started.child.stdin.write(workerInput);
        nativeEvent(job, { type: 'started', pid: started.pid });
        const receipt = await started.result;
        if(receipt.cancelled||!receipt.confined||receipt.exitCode!==0||job.failure)job.controller.abort(job.failure??failure('native_worker_terminated',403));
        await Promise.allSettled([...job.browserOperations]);
        pending += decoder.end();
        try { nativeOptions.onTermination?.({ ...job.lease.scope, token: lease.token, receipt }); } catch { /* Observer only. */ }
        if (receipt.cancelled || !receipt.confined || job.failure || (input.kind === 'writer' && (!job.result?.ok || receipt.exitCode !== 0 || pending))) {
          await runtime.cancelLease({ directory: input.directory, token: lease.token });
          await recordCancelled(job.lease, toV1ToolName(input.tool)); await cleanup(job.lease);
          try { nativeOptions.onOutcome?.({ ...job.lease.scope, token: lease.token, state: 'cancelled' }); } catch { /* Observer only. */ }
          nativeEvent(job, { type: 'settled', ok: false, receipt, error: job.result?.error ?? { message: job.failure?.message ?? 'execution_cancelled' } }, true);
          return;
        }
        await nativeRecheck({ ...input, phase: 'publication', token: lease.token }); // Exact lease authority survives a background Tool return.
        const publication = await runtime.finish({ directory: input.directory, token: lease.token });
        published = true;
        try { nativeOptions.onOutcome?.({ ...job.lease.scope, token: lease.token, state: 'published' }); } catch { /* Observer only. */ }
        await options.recordReceipt?.({ ...await runtime.executionReceipt({ directory: input.directory, token: lease.token }), tool: toV1ToolName(input.tool) });
        await cleanupAfterPublication(job.lease);
        nativeEvent(job, { type: 'settled', ok: true, receipt, result: nativePublicationResult(job.result?.result, publication, job.lease,input.tool) }, true);
      } catch (cause) {
        job.resolveChild();
        await Promise.allSettled([...job.browserOperations]);
        if (published) throw cause; // Publication is durable; recovery retries its receipt/cleanup.
        if (!launched) {
          await jobs.cancel(job.lease); await runtime.cancelUnstartedCall({ ...input, token: lease.token }); await cleanup(job.lease);
        } else {
          // Recheck/publication errors occur only after verified termination;
          // missing termination evidence keeps the lease for recovery.
          const receipt = await readSessionExecutionReceipt(job.lease);
          // Materialization can fail after its publication decision was committed.
          // The canonical ledger read recovers that intent before success; never
          // cancel or clean a durable publication as though it were a failure.
          const durable = await runtime.leaseForCall(input);
          if (durable?.state === 'published') {
            published = true;
            const publication = await runtime.finish({ directory: input.directory, token: lease.token });
            try { nativeOptions.onOutcome?.({ ...job.lease.scope, token: lease.token, state: 'published' }); } catch { /* Observer only. */ }
            await options.recordReceipt?.({ ...await runtime.executionReceipt({ directory: input.directory, token: lease.token }), tool: toV1ToolName(input.tool) });
            await cleanupAfterPublication(job.lease);
            nativeEvent(job, { type: 'settled', ok: true, receipt, result: nativePublicationResult(job.result?.result, publication, job.lease,input.tool) }, true);
            return;
          }
          await runtime.cancelLease({ directory: input.directory, token: lease.token }); await cleanup(job.lease);
          nativeEvent(job, { type: 'settled', ok: false, receipt, error: { message: cause.message, code: cause.code } }, true);
          return;
        }
        nativeEvent(job, { type: 'settled', ok: false, error: { message: cause.message, code: cause.code } }, true);
      } finally { signal?.removeEventListener('abort', abort); job.done = true; for (const wake of job.waiters) wake(); job.waiters.clear(); }
    })();
    void job.settled.catch((cause) => { nativeEvent(job, { type: 'uncertain', error: { code: cause.code ?? 'mutation_termination_unconfirmed' } }, true); });
    return { handle: handleID };
  };
  const nativeExecution = async (input, { signal } = {}) => ['start', 'helper', 'direct-admit', 'control-begin'].includes(input.action)
    ? acquireController(lifetime => executeNativeExecution(input, { signal: AbortSignal.any([lifetime, ...(signal ? [signal] : [])]) }))
    : executeNativeExecution(input, { signal });
  const nativeContextAssets = async (input, requestOptions = {}) => {
    // This runs before Step.Started. Its constructor captures canonical user
    // input and current hook authority; no assistant/tool identity is invented.
    options.assertExecutionReady?.();
    if (typeof input?.directory !== 'string' || nativeOptions?.locations && !nativeOptions.locations.some(location => location.directory === input.directory)) throw failure('native_image_scope_invalid', 403);
    contextAssetLifetime.signal.throwIfAborted();
    let slot = contextImageStates.get(input.directory);
    if (!slot) {
      if (contextImageStates.size >= 128) throw failure('native_context_assets_capacity_exceeded', 503);
      slot = { tail: Promise.resolve(), pending: 0, state: undefined }; contextImageStates.set(input.directory, slot);
    }
    if (slot.pending >= 8) throw failure('native_context_assets_capacity_exceeded', 503);
    const previous = slot.tail; let release;
    slot.tail = new Promise(resolve => { release = resolve; }); slot.pending++;
    const signal = AbortSignal.any([contextAssetLifetime.signal, ...(requestOptions.signal ? [requestOptions.signal] : [])]);
    const work = (async () => {
      try {
        await previous; signal.throwIfAborted(); options.assertExecutionReady?.();
        return await executeNativeContextAssets(input, { signal }, { runtime, nativeOptions, nativeHandles, preparations, launcher,
          cleanup, cleanupAfterPublication, recordReceipt: options.recordReceipt, generation, state: slot.state,
          saveState: state => { slot.state = state; } });
      } finally { slot.pending--; release(); }
    })();
    contextAssetWorks.add(work);
    try { return await work; } finally { contextAssetWorks.delete(work); }
  };
  let retentionReady = false;
  const nativeInterviewDocument = async (input, authority) => {
    // Private Node service owner only. No wire action accepts this authority.
    options.assertExecutionReady?.();
    if (typeof input?.directory !== 'string' || nativeOptions?.locations && !nativeOptions.locations.some(location => location.directory === input.directory)) throw failure('native_interview_scope_invalid', 403);
    contextAssetLifetime.signal.throwIfAborted();
    const signal = AbortSignal.any([contextAssetLifetime.signal, ...(authority?.signal ? [authority.signal] : [])]);
    const work = executeNativeInterviewDocument(input, { ...authority, signal }, { runtime, nativeOptions, nativeHandles, preparations, launcher,
      cleanup, cleanupAfterPublication, recordReceipt: options.recordReceipt, generation });
    contextAssetWorks.add(work);
    try { return await work; } finally { contextAssetWorks.delete(work); }
  };
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
  const isConfined = async () => {
    generation();
    return Boolean(nativeOptions?.isReady && await nativeOptions.isReady())
      && await verifySessionExecutionLauncher({ launcher: launcher() });
  };
  const executions = {
    isConfined,
    cancelAndWait: async (input) => {
      generation();
      if (typeof nativeOptions?.stopSessions !== 'function') throw failure('native_runner_settlement_unavailable', 503);
      const stopped = await nativeOptions.stopSessions(input);
      if (stopped?.terminated !== true || input.sessions.some((id) => !stopped.sessions?.includes(id))) throw failure('mutation_cancellation_failed');
      await nativeExecution({ action: 'cancel-sessions', sessions: input.sessions });
      for (const lease of await runtime.activeLeases(input)) {
        if (lease.executionKind === 'process') await readSessionExecutionReceipt(lease);
        await runtime.cancelLease({ directory: lease.directory, token: lease.token });
        await recordCancelled(lease, lease.scope?.tool); await cleanup(lease);
      }
      return { terminated: true, sessions: input.sessions };
    },
  };
  const rawCoordinator = createScopedRevertCoordinator({ runtime, executions, openchamberDataDir: options.dataDirectory,
    nativeConversation: options.nativeExecution?.conversation,
    onDiagnostic: options.onDiagnostic, legacy: options.legacyChanges,
    openCodeClient: options.openCodeClient });
  const coordinator = Object.fromEntries(Object.entries(rawCoordinator).map(([name, action]) => [name, typeof action === 'function'
    ? (input) => activity([input?.sessionID], () => action(input)) : action]));
  const persistCursorRecord = async ({ sessionID, directory, record }) => {
    generation();
    if (typeof nativeOptions?.cursor?.persist !== 'function') throw failure('native_cursor_owner_unavailable', 503);
    const result = await nativeOptions.cursor.persist({ sessionID, directory, record });
    if (record?.info?.role === 'assistant') {
      const lease = await runtime.leaseForCall({ directory, sessionID, callID: `cursor_${record.info.id}` });
      if (lease?.state === 'published') await cursorReceipts(lease, record);
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
    generation();
    if (typeof nativeOptions?.cursor?.withExecution !== 'function') throw failure('native_cursor_owner_unavailable', 503);
    return nativeOptions.cursor.withExecution(input, () => startCursorOwned(input));
  };
  const startCursorOwned = async (input) => {
    const current = await session(input);
    if (!await isConfined(input)) throw failure('mutation_runtime_unsupported');
    const record = await readMessage(input.sessionID, input.assistantMessageID, input.directory);
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
        for (const key of Object.keys(env)) if (/^(DEVRYAN_.*(?:TOKEN|URL)|OPENCODE_SERVER_(?:PASSWORD|USERNAME)|OPENCODE_AUTH_CONTENT)$/.test(key)) delete env[key];
        return env;
      },
    });
    const result = handle.result.then(async (value) => {
      const record = await readMessage(input.sessionID, input.assistantMessageID, input.directory);
      await cursorReceipts(handle.lease, record);
      return value;
    });
    void result.catch(() => {});
    return { ...handle, result };
  };
  const dispatch = async (input, recheckNative) => {
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
      const record = await readMessage(input.sessionID, input.userMessageID, input.directory);
      if (record?.info?.id !== input.userMessageID || record.info.role !== 'user' || record.info.sessionID !== input.sessionID) {
        throw failure('capture_identity_mismatch');
      }
      return runtime.registerPrompt({ ...input, parentID: current.parentID });
    }
    if (!identity(input.messageID) || !identity(input.callID)) throw failure('invalid_capture_identity', 400);
    const record = await executionPhase('tool_identity_lookup', () => readMessage(input.sessionID, input.messageID, input.directory));
    const call = record?.parts?.find((part) => part.type === 'tool' && part.callID === input.callID);
    if (record?.info?.role !== 'assistant' || record.info.sessionID !== input.sessionID || !call || call.tool !== input.tool) {
      throw failure('capture_identity_mismatch');
    }
    if (record.turnOwnership?.source !== 'native-sequence'
      || record.turnOwnership.userMessageID !== record.info.parentID) throw failure('capture_identity_mismatch');
    await recheckNative?.();
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
      try { checkExecutionAdmission(); await recheckNative?.(); }
      catch (cause) {
        if (recheckNative) {
          await runtime.cancelUnstartedCall({ ...input, token: lease.token });
          await cleanup(lease);
        }
        throw cause;
      }
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
    await recheckNative?.();
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
  const finish = (input, recheckNative) => withExecutionSummary(input, () => dispatch(input, recheckNative),
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
  const dispatchPlugin = (input, recheckNative) => input.action === 'direct-finish' ? directFinish(input)
    : input.action === 'finish' ? finish(input, recheckNative)
    : ['admit', 'prompt', 'begin', 'child', 'cancel-before-start', 'prepare-poll', 'claim', 'direct-admit'].includes(input.action)
    // Fail after 25 s without progress (this request's own work or the lock
    // holder it queues behind), never later than 50 s: the companion's RPC
    // limit is 60 s, and deadline-free commits may run past the abort.
    ? withExecutionAdmission(input, () => executionPhase(input.action === 'cancel-before-start' ? 'cleanup' : 'host_request', () => dispatch(input, recheckNative)), {
      timeoutMs: options.admissionTimeoutMs ?? 50_000, idleMs: options.admissionIdleMs ?? 25_000, onDiagnostic: options.onDiagnostic,
      // Healthy host requests are frequent and fast; they are journaled only when slow or failed.
      // Baseline QA lowers the threshold to journal every request's phase summary.
      summary: { minMs: options.admissionSummaryMinMs ?? 250 },
    }) : dispatch(input, recheckNative);
  const plugin = () => {
    generation();
    return Promise.reject(createCapabilityAbsentError('execution_bridge'));
  };
  const assertNativeManagedAvailable = async () => {
    if (generation() !== 2) throw failure('native_execution_generation_mismatch');
    if (!nativeOptions || typeof nativeOptions.isReady !== 'function' || typeof nativeOptions.recheckPermit !== 'function'
      || !await nativeOptions.isReady()) throw createCapabilityAbsentError('native_managed_execution');
  };
  // Constructor-owned native task calls share the canonical control ledger;
  // they never open the legacy companion/plugin RPC for generation 2.
  const nativeControl = async ({ action, invocation, token }, signal) => {
    if (!['begin', 'finish'].includes(action)
      || !invocation.input || typeof invocation.input !== 'object' || Array.isArray(invocation.input)
      || (action === 'finish' && !identity(token))) throw failure('invalid_capture_identity', 400);
    await assertNativeManagedAvailable();
    await nativeRecheck(invocation); signal?.throwIfAborted();
    const capture = { directory: invocation.directory, sessionID: invocation.sessionID,
      messageID: invocation.messageID, callID: invocation.callID, tool: invocation.tool, kind: 'control', protocol: 3,
      argsDigest: createHash('sha256').update(JSON.stringify(invocation.input)).digest('hex'), action,
      ...(action === 'finish' ? { token } : {}) };
    return activity([capture.sessionID], () => dispatchPlugin(capture, async () => {
      await assertNativeManagedAvailable();
      await nativeRecheck(invocation); signal?.throwIfAborted();
    }));
  };
  const nativeManagedControl = async input => {
    const { invocation } = input, origin = invocation?.authorization?.input?.provenance;
    if (origin?.kind !== 'plugin' || !(invocation?.tool === 'devryan_task' && origin.id === 'devryan.managed-task'
      || invocation?.tool === 'council_session' && origin.id === 'devryan.council')) throw failure('invalid_capture_identity', 400);
    return input.action === 'begin' ? acquireController(signal => nativeControl(input, signal)) : nativeControl(input);
  };
  // Scheduler child registration may run after the tool permit is released.
  // Its durable authority is the exact real parent control call, not inherited
  // request metadata or the child's projected parentID alone.
  const nativeManagedChild = async input => acquireController(async signal => {
    await assertNativeManagedAvailable();
    if (!identity(input.parentID) || !identity(input.parentCallID)) throw failure('invalid_capture_identity', 400);
    return activity([input.sessionID, input.parentID], async () => {
      const child = await session(input);
      if (child.parentID !== input.parentID) throw failure('invalid_session_lineage');
      if (!await verifySessionExecutionLauncher({ launcher: launcher() })) throw failure('mutation_runtime_unsupported');
      const lease = await runtime.leaseForCall({ directory: input.directory, sessionID: input.parentID, callID: input.parentCallID });
      if (!lease || lease.executionKind !== 'control' || lease.preparation !== 'none'
        || !['ready', 'published'].includes(lease.state) || lease.scope?.sessionID !== input.parentID
        || lease.scope.callID !== input.parentCallID || !identity(lease.scope.messageID)) throw failure('invalid_session_lineage');
      const record = await readMessage(input.parentID, lease.scope.messageID, input.directory);
      const call = record?.parts?.find(part => part.type === 'tool' && part.callID === input.parentCallID);
      if (record?.info?.role !== 'assistant' || record.info.id !== lease.scope.messageID || record.info.sessionID !== input.parentID
        || record.turnOwnership?.source !== 'native-sequence' || record.turnOwnership.userMessageID !== record.info.parentID
        || record.info.parentID !== lease.scope.userMessageID || !['devryan_task', 'council_session'].includes(call?.tool)) throw failure('invalid_session_lineage');
      await runtime.assertAdmission({ directory: input.directory, sessionID: input.sessionID });
      signal.throwIfAborted();
      return runtime.registerChild(input);
    });
  });
  // Background first build of a project's ledger, so its first confined call
  // does not stall. One build at a time per host: opening another project
  // cancels the current one (committed batches are kept and resumed by the
  // next observation), and host drain cancels it. A real call arriving
  // meanwhile joins the in-flight pass. Kill switch: DEVRYAN_LEDGER_PREWARM=0.
  let ledgerWarm = null;
  const warmLedger = ({ directory } = {}) => {
    contextAssetLifetime.signal.throwIfAborted();
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
  const nativeShellJobReceipt = async (input) => {
    const lease = await runtime.nativeShellJob(input);
    if (!['published', 'cancelled'].includes(lease.state)) throw failure('native_shell_job_unsettled', 409);
    const receipt = await readSessionExecutionReceipt(lease);
    if (!receipt.terminated || !receipt.confined) throw failure('mutation_termination_unconfirmed', 503);
    return { lease, receipt };
  };
  return { get retentionReady() { return retentionReady; }, runtime, executions, coordinator, plugin, nativeManagedControl, nativeManagedChild, nativeExecution, nativeContextAssets, nativeInterviewDocument, nativeShellJobReceipt, isConfined, persistCursorRecord, startCursor, assertLegacyRevertAllowed, warmLedger,
    recover: async () => {
      retentionReady = false; let failed = false;
      const report = (cause) => {
        failed = true;
        try { options.onDiagnostic?.({ event: 'session_revert', phase: 'recovery_failed', code: cause.code || 'mutation_recovery_required' }); } catch { /* Observer only. */ }
      };
      // Orphaned socket directories are disposable; never a recovery failure.
      if (nativeOptions?.socketDirectory !== null) void sweepExecutionSocketDirectories().catch(() => {});
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
    settleController,
    drain };

}
