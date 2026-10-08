import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createSessionExecutionHost } from '../packages/web/server/lib/opencode/session-execution-host.js';
import { createManagedOrchestrationPrivateHost } from '../packages/web/server/lib/orchestration/private-host.js';
import { createNativeAdmissionOwner } from '../packages/web/server/lib/opencode/runtime-host/native-admission-owner.js';
import { createOpenCodeClient } from '../packages/web/server/lib/opencode/opencode-client/index.js';
import { createPrivilegedOpenCodeClient } from '../packages/web/server/lib/opencode/opencode-client/privileged.js';
import { createNativeRevertConversation } from '../packages/web/server/lib/opencode/session-revert-coordinator.js';
import { createOpenCodeAdmission, createV2MessageId } from '../packages/web/server/lib/opencode/v2/admission.js';
import { reservePort } from './qa/process.mjs';
import { createQaHostLaunchEnvironment } from './qa/launch-environment.mjs';
import { repositoryRoot, verifyNativeAcceptanceArtifacts, captureNativeAcceptanceSource, hashNativeFixtureValue } from './opencode-v2-native/artifacts.mjs';
import { startNativeFixtureProcess } from './opencode-v2-native/fixture-process.mjs';
import { createNativeManagedFixture } from './opencode-v2-native/managed-fixture.mjs';
import { assertNativeCancellationSettled, runForegroundShell, runBackgroundShell, runTrackedBackgroundShell, runPermissionCases, runEscapedDescendantCancellation } from './opencode-v2-native/process-lanes.mjs';
import { runWriterByteEdges, runSameFileWriters, runProtectedRootCases, runInterruptedPublication, runCancelledWriterTransforms } from './opencode-v2-native/writer-edge-cases.mjs';
import { nativeBackgroundMarkerCount, runControllerCrashHold, runPendingBackgroundRestart } from './opencode-v2-native/restart-lane.mjs';
import { runNativeRemovalCases } from './opencode-v2-native/removal-lanes.mjs';
import { assertWriterOutcome, assertTerminatedBeforeOutcome, snapshotFiles, writerCases } from './opencode-v2-native/assertions.mjs';
import { createRunRoot } from './qa/run-root.mjs';

const git = promisify(execFile);
const admittedOperations = new Set(['session.create', 'session.prompt', 'session.switchAgent', 'session.switchModel', 'session.setPermissions',
  'session.setMetadata', 'session.rename', 'session.revert.stage', 'session.revert.clear', 'session.revert.commit',
  'tool.execute', 'runner.drain', 'store.claim', 'store.countResume', 'store.releaseChildClaims', 'restart.resume',
  'execution.wake', 'execution.resume', 'inbox.compaction', 'session.generate']);
const failure = code => Object.assign(new Error(code), { code, status: 403 });
const errorEvidence = error => ({ name: error.name, message: error.message, stack: error.stack,
  ...(error.nativeError !== undefined ? { nativeError: error.nativeError } : {}),
  ...(error.code !== undefined ? { code: error.code } : {}), ...(error.errors ? { causes: Array.from(error.errors, errorEvidence) } : {}) });

export const runNativeWriterAcceptance = async (options = {}) => {
  const artifacts = await verifyNativeAcceptanceArtifacts(options);
  const source = await captureNativeAcceptanceSource();
  const run = createRunRoot({ parent: path.join(repositoryRoot, '.cache/v2-validation'), prefix: 'native-', owner: 'scripts/verify-opencode-v2-native.mjs' });
  const root = await fs.realpath(run.dir);
  const directory = path.join(root, 'project');
  const home = path.join(root, 'home');
  const tmp = path.join(root, 'tmp');
  const dataDirectory = path.join(root, 'web-data');
  for (const folder of [directory, home, tmp, dataDirectory, ...['config', 'data', 'state', 'cache', 'git-template'].map(name => path.join(home, name))]) await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(tmp, 'package.json'), '{"type":"commonjs"}\n');
  const gitConfig = path.join(root, 'git-config'); await fs.writeFile(gitConfig, '');
  const env = createQaHostLaunchEnvironment({ HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'data'),
    XDG_STATE_HOME: path.join(home, 'state'), XDG_CACHE_HOME: path.join(home, 'cache'), TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    GIT_CEILING_DIRECTORIES: root, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' });
  const bunProbe = spawnSync('bun', ['--print', 'process.execPath'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(bunProbe.status, 0, 'Bun executable required');
  const bun = bunProbe.stdout.trim(); assert.ok(path.isAbsolute(bun));
  await git('git', ['init', '--quiet', `--template=${path.join(home, 'git-template')}`], { cwd: directory, env });
  await fs.writeFile(path.join(directory, 'seed.txt'), 'native-read-marker\n');
  await fs.writeFile(path.join(directory, 'sequential.txt'), 'original\n');
  await fs.writeFile(path.join(directory, 'ambiguous.txt'), 'duplicate\nduplicate\n');
  await fs.writeFile(path.join(directory, 'delete-target.txt'), 'owned removable bytes\n');
  await fs.writeFile(path.join(directory, 'removalfail-target.txt'), 'must survive failed native patch\n');
  const rgTarget = path.join(home, 'cache/opencode/bin/rg'); await fs.mkdir(path.dirname(rgTarget), { recursive: true });
  await fs.copyFile(artifacts.rg, rgTarget); await fs.chmod(rgTarget, 0o755);
  const token = randomBytes(32).toString('base64url');
  const observations = [], receipts = [], diagnostics = [], cases = [], transcripts = [];
  const nativeCalls = new Map();
  const shellAckPermits = new Map();
  const trackedSessions = new Set();
  let nativeUrl, child, owner, nativeEpoch = 1;
  let nativeRequestCount = 0, privateRpcCount = 0, managedWakeAttribution;
  let capturedPrompt;
  const controllerRestarts = [];
  const deps = { getRuntime: () => ({ generation: 2, baseUrl: nativeUrl, version: '2.0.24', epoch: nativeEpoch,
    paths: { home, config: env.XDG_CONFIG_HOME, data: env.XDG_DATA_HOME, state: env.XDG_STATE_HOME, cache: env.XDG_CACHE_HOME } }),
    getAuthHeaders: () => ({ authorization: `Bearer ${token}`, ...owner?.requestHeaders() }), recordDiagnostic: record => diagnostics.push(record),
    withNativeWebOperation: (spec, action) => owner.withWebOperation(spec, action),
    fetchImpl: async (url, init) => {
      nativeRequestCount++;
      const headers = new Headers(init?.headers);
      if (!capturedPrompt && typeof url === 'string' && init?.method === 'POST'
        && new URL(url).pathname.endsWith('/prompt') && headers.has('x-devryan-native-permit')) {
        assert.equal(typeof init.body, 'string', 'Native admitted prompt payload missing');
        // Retain this exact fixture request only in memory. Neither its token
        // nor authorization/body is included in results or trace output.
        capturedPrompt = { url, body: init.body, headers };
      }
      return fetch(url, init);
    } };
  const admission = createOpenCodeAdmission(deps, { beforePromptDispatch: (receipt, context) => managed.admitNativePrompt(receipt, context),
    onPromptDispatchFailure: receipt => managed.markNativePromptUncertain(receipt), nativeOwner: {
    requestHeaders: () => owner.requestHeaders(), withAcceptedOperation: (accepted, action) => owner.withAcceptedOperation(accepted, action),
    checkQueuedPromptAdmission:(...args)=>owner.checkQueuedPromptAdmission(...args),
    stageQueuedPromptAdmission:(...args)=>owner.stageQueuedPromptAdmission(...args),
    assertQueuedPromptReconciled:(...args)=>owner.assertQueuedPromptReconciled(...args),
    queuedPromptWasRejected:(...args)=>owner.queuedPromptWasRejected(...args),
    updateAcceptedOperation: accepted => owner.updateAcceptedOperation(accepted),
  } });
  const client = createOpenCodeClient({ ...deps, getAdmission: () => admission });
  const ready = () => Boolean(child && nativeUrl);
  const privileged = createPrivilegedOpenCodeClient(deps);
  const setPermissions = (sessionID, rules) => admission.withSessionLock(sessionID,
    () => owner.withCommandSelection({ sessionID }, () => privileged.setPermissions(sessionID, rules, { directory })));
  const conversation = createNativeRevertConversation({ openCodeClient: client, privilegedClient: privileged,
    isReady: ready, admissionOwner: { withRevertOperation: (input, run) => owner.withRevertOperation(input, run),
      releaseTransactionHolds: input => owner.releaseTransactionHolds(input), recoverTransactionHolds: input => owner.recoverTransactionHolds(input) } });
  const writerConfig = { formatter: false };
  let materializeHook;
  const host = createSessionExecutionHost({ dataDirectory, openCodeClient: client, getLauncher: () => artifacts.launcher,
    onMaterialize: row => materializeHook?.(row),
    buildOpenCodeUrl: route => new URL(route, nativeUrl).href, getOpenCodeAuthHeaders: deps.getAuthHeaders,
    onDiagnostic: record => diagnostics.push(record), recordReceipt: receipt => { receipts.push({ sessionID: receipt.sessionID, callID: receipt.callID, tool: receipt.tool, files: receipt.files.map(file => file.path) }); },
    nativeExecution: { conversation, isReady: ready, writerConfig, readRoots: [directory], protectedRoots: [home, dataDirectory],
      socketDirectory: null, workerBrowsers: false, helperRoots: [directory], gitCommand: '/usr/bin/git', workerCommand: bun,
      workerArgs: [path.join(repositoryRoot, 'packages/web/server/lib/opencode/runtime-host/writer-worker.ts')], workerEnvironment: env,
      recheckPermit: input => owner.recheckExecution(input),
      onTermination: record => observations.push({ ...record, phase: 'termination_verified' }),
      onOutcome: record => observations.push({ ...record, phase: record.state === 'published' ? 'published' : 'discarded' }),
      stopSessions: async ({ sessions }) => { for (const sessionID of sessions) await child.call({ action: 'hold', sessionID }); return { terminated: true, sessions }; } } });
  const ownerID = `native_${createHash('sha256').update(path.join(home, 'data/native.db')).digest('hex')}`;
  owner = createNativeAdmissionOwner({ runtime: host.runtime, directory, ownerID,
    withSessionLock: admission.withSessionLock,
    verifyQueuedPrimaryIdle:input=>child.call({action:'queued-primary-idle-owned',...input}),
    readQueuedPrimaryRecord:sessionID=>managed.primaryRuntime.readRecord(sessionID),
    captureQueuedPrimaryAdmission:sessionID=>managed.primaryRuntime.captureNativePromptAdmission(sessionID),
    bindShellJob: input => host.nativeExecution({ ...input, action: 'bind-shell-job' }),
    getShellJobReceipt: input => host.nativeShellJobReceipt(input),
    verifyManagedTaskDispatch: input => managed.verifyNativeTaskDispatch(input),
    onContinuation: async input => {
      if (input.operation === 'execution.wake') {
        return (await child.call({ action: 'wake-deferred-owned', sessionID: input.sessionID, permit: input.permit })).result;
      }
      if (input.operation === 'shell.recover') {
        await child.call({ action: 'recover-shell-owned', sessionID: input.sessionID, jobID: input.jobID });
        return;
      }
      if (input.operation !== 'shell.complete') throw failure('fixture_continuation_unavailable');
      return (await child.call({ action: 'reconcile-shell-owned', sessionID: input.sessionID,
        messageID: input.messageID, permit: input.permit })).result;
    },
    getSession: sessionID => client.sessions.get(sessionID, { directory }),
    // This constructor grant belongs only to this private acceptance fixture.
    // The owner maps and compares each exact web effect (including the native
    // pending permission identity); it does not extend detached policy below.
    captureWebAuthorization: async (request, session) => {
      const acceptedSelection = ['admission.prompt', 'admission.command.selection'].includes(request.operation);
      const mappedWebRequest = ['POST', 'PATCH', 'DELETE'].includes(request.method) && typeof request.path === 'string';
      if ((!acceptedSelection && !mappedWebRequest) || request.directory !== directory
        || (request.sessionID && request.sessionID !== session?.id)) {
        throw failure('fixture_web_operation_denied');
      }
      return async () => {
        if (await fs.realpath(session?.directory ?? request.directory) !== directory) throw failure('fixture_directory_denied');
      };
    },
    authorizeOperation: async (request, session) => {
      if (request.operation === 'primary.step') {
        if (request.parentAuthorization?.operation !== 'runner.drain') throw failure('fixture_primary_origin_denied');
      } else if (!admittedOperations.has(request.operation)) throw failure(`fixture_operation_unavailable:${request.operation}`);
      if (session && await fs.realpath(session.directory) !== directory) throw failure('fixture_directory_denied');
      if (request.operation === 'session.create' && request.input?.location?.directory !== directory) throw failure('fixture_directory_denied');
      if (request.operation === 'tool.execute') {
        const provenance = request.input?.provenance;
        if (provenance?.kind === 'plugin') {
          if (provenance.id !== 'devryan.managed-task' || request.input.toolID !== 'devryan_task'
            || provenance.manifestDigest !== managedDigest) throw failure('fixture_origin_denied');
        } else if (provenance?.kind !== 'native' || provenance.manifestDigest !== artifacts.packages.core.manifestSha256) throw failure('fixture_origin_denied');
      }
    } });
  const managedDigest = createHash('sha256').update(await fs.readFile(path.join(repositoryRoot, 'packages/web/server/lib/opencode/runtime-host/managed-task.ts'))).digest('hex');
  const managed = createNativeManagedFixture({ client, admissionOwner: owner, executionHost: host, directory, dataDirectory,
    buildOpenCodeUrl: route => new URL(route, nativeUrl).href, getOpenCodeAuthHeaders: deps.getAuthHeaders, environment: env, observations, diagnostics });
  const bridge = createManagedOrchestrationPrivateHost({ handleRpc: async ({ method, params }, context) => {
    privateRpcCount++;
    try {
      if (method === 'native.primary-step' || method === 'native.managed-task') {
        observations.push({ phase: 'managed_rpc_received', method, at: Date.now() });
        const result = await managed.handleRpc(method, params, context);
        observations.push({ phase: 'managed_rpc_completed', method, at: Date.now() });
        return result;
      }
      if (method.startsWith('native.admission.')) {
        const result = await owner.handleRpc(method, params);
        if (method === 'native.admission.authorize' && params.operation === 'job.shell.ack') {
          shellAckPermits.set(result.token, { sessionID: params.sessionID, jobID: params.input.jobID });
          if (await nativeBackgroundMarkerCount(path.join(home, 'data/native.db'), params.input.notificationID, env) === 1) {
            observations.push({ phase: 'native_shell_marker_present', sessionID: params.sessionID,
              jobID: params.input.jobID, notificationID: params.input.notificationID, at: Date.now() });
          }
        } else if (method === 'native.admission.release' && shellAckPermits.has(params.token)) {
          observations.push({ phase: 'native_shell_ack_released', ...shellAckPermits.get(params.token), at: Date.now() });
          shellAckPermits.delete(params.token);
        }
        return result;
      }
      if (method.startsWith('execution.native.')) {
        if (method === 'execution.native.start') observations.push({ phase: 'execution_requested', callID: params.callID, tool: params.tool });
        const result = await host.nativeExecution({ ...params, action: method.slice('execution.native.'.length) }, context);
        if (method === 'execution.native.start') nativeCalls.set(result.handle, params.callID);
        if (method === 'execution.native.read') for (const event of result.events ?? []) {
          const callID = nativeCalls.get(params.handle);
          if (event.type === 'started') observations.push({ phase: 'execution_started', callID, pid: event.pid });
          if (event.type === 'output') observations.push({ phase: 'execution_output', callID, text: Buffer.from(event.data, 'base64').toString('utf8') });
          if (event.type === 'permission') observations.push({ phase: 'permission_requested', callID,
            protectedSentinelObserved: JSON.stringify(event.input).includes('DEVRYAN_PROTECTED_READ_SENTINEL') });
        }
        return result;
      }
      throw failure('fixture_rpc_unavailable');
    } catch (error) {
      // Private fixture data only; never retain tokens or full RPC parameters.
      diagnostics.push({ event: 'fixture_rpc_failure', at: Date.now(), method, operation: params?.operation,
        code: error.code ?? error.name, message: error.message });
      throw error;
    }
  } });
  let cleanup;
  let runError;
  let configurationSha256;
  const fixtureFile = path.join(root, 'fixture.json');
  try {
    const privateEnvironment = await bridge.start();
    const unauthorized = await fetch(privateEnvironment.DEVRYAN_ORCHESTRATION_URL, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'native.admission.ready', params: {} }) });
    assert.equal(unauthorized.status, 401, 'Private bridge accepted an unauthenticated caller');
    cases.push({ id: 'private-bridge-authentication', status: 'passed' });
    const configuration = { model: 'sim/m1', shell: '/bin/sh', snapshots: false, permissions: [{ action: '*', resource: '*', effect: 'allow' }],
      providers: { sim: { name: 'DevRyan native acceptance', package: '@ai-sdk/openai-compatible', settings: { baseURL: 'https://api.openai.com/v1', apiKey: 'fixture-placeholder' },
        models: { m1: { name: 'Fixture model', limit: { context: 200000, output: 32000 } },
          'gpt-5-native-fixture': { name: 'Fixture patch model', limit: { context: 200000, output: 32000 } } } } },
      agents: { orchestrator: { mode: 'primary', model: 'sim/m1' }, fixer: { mode: 'subagent', model: 'sim/m1' }, title: { disabled: true } } };
    configurationSha256 = hashNativeFixtureValue(configuration);
    await fs.writeFile(fixtureFile, JSON.stringify({ root, directory, configuration, token,
      databasePath: path.join(home, 'data/native.db'), bridgeUrl: privateEnvironment.DEVRYAN_ORCHESTRATION_URL,
      bridgeToken: privateEnvironment.DEVRYAN_ORCHESTRATION_TOKEN, coreDigest: artifacts.packages.core.manifestSha256,
      managedDigest,
      simulationDigest: artifacts.packages.simulation.providerSha256, simulationEndpoint: `ws://127.0.0.1:${await reservePort()}` }), { mode: 0o600 });
    child = startNativeFixtureProcess(bun, [path.join(repositoryRoot, 'scripts/opencode-v2-native/fixture-host.ts'), fixtureFile], { cwd: directory, env });
    nativeUrl = (await child.ready).url;
    const restartNative = async ({ crash, afterExit, beforeOpen }) => {
      const previous = child;
      const evidence = crash ? await previous.crash() : await previous.stop();
      controllerRestarts.push(evidence);
      await fs.writeFile(path.join(root, `native-controller-${controllerRestarts.length}.log`), previous.getLog());
      await afterExit?.();
      await host.nativeExecution({ action: 'cancel-sessions', sessions: [...trackedSessions] });
      assert.equal((await host.runtime.activeLeases({ directory, sessions: [...trackedSessions] }))
        .filter(lease => lease.executionKind === 'process').length, 0,
      'Controller replacement retained an unresolved native process');
      // Epoch rotation must also drain already accepted durable acknowledgements.
      await owner.invalidateController();
      nativeUrl = undefined; nativeEpoch++;
      child = startNativeFixtureProcess(bun, [path.join(repositoryRoot, 'scripts/opencode-v2-native/fixture-host.ts'), fixtureFile], { cwd: directory, env });
      nativeUrl = (await child.ready).url;
      await beforeOpen?.(child);
      await child.call({ action: 'open' });
      await owner.recoverShellContinuations({ directory });
      return evidence;
    };
    assert.equal((await fetch(`${nativeUrl}/api/info`)).status, 401, 'Native product listener accepted an unauthenticated caller');
    cases.push({ id: 'native-listener-authentication', status: 'passed' });
    await assert.rejects(client.sessions.create({ title: 'Startup hold probe', model: { providerID: 'sim', modelID: 'm1' } }, { directory }),
      error => error.statusCode === 409 && /native_startup_held/.test(error.message),
      'Native listener admitted a session before the real web owner opened startup');
    cases.push({ id: 'startup-admission-hold', status: 'passed' });
    await child.call({ action: 'open' });
    await owner.recoverShellContinuations({ directory });
    const session = await client.sessions.create({ title: 'Native writer acceptance', model: { providerID: 'sim', modelID: 'm1' } }, { directory });
    assert.ok(session?.id, 'Native session not created');
    const begin = async (scenario, options = {}) => {
      observations.push({ phase: 'scenario_begin', caseID: scenario.id, at: Date.now() });
      const command = await child.call({ action: 'scenario', caseID: scenario.id, tool: scenario.tool, input: scenario.input,
        deniedInventory: scenario.deniedInventory === true,
        backgroundRestart: options.backgroundRestart === true,
        parallel: options.parallel === true, sameFile: options.sameFile === true, background: options.background === true });
      const sessionID = options.sessionID ?? session.id;
      trackedSessions.add(sessionID);
      const messageID = createV2MessageId();
      // The pinned native patch plugin selects patch versus edit/write from
      // the model ID. Declare both simulated routes and use its real hook.
      await client.prompts.prompt(sessionID, { messageID,
        ...(options.agent ? { agent: options.agent } : {}), ...(options.variant ? { variant: options.variant } : {}),
        model: { providerID: 'sim', modelID: scenario.tool === 'patch' ? 'gpt-5-native-fixture' : 'm1' },
        parts: [{ type: 'text', text: command.marker }] },
        { directory, origin: 'native_acceptance', delivery: 'queue', timeoutMs: 30_000 });
      observations.push({ phase: 'scenario_prompt_accepted', caseID: scenario.id, at: Date.now() });
      return { sessionID, messageID };
    };
    const settle = async (scenario, options = {}) => {
      const sessionID = options.sessionID ?? session.id;
      const deadline = Date.now() + 60_000;
      let messages, completed = false;
      while (Date.now() < deadline) {
        const page = await client.sessions.messages(sessionID, {}, { directory });
        assert.ok(page && Array.isArray(page.records), 'Native projected message page missing records');
        messages = page.records;
        if (messages.some(message => message.parts?.some(part => part.type === 'text' && part.text === `completed ${scenario.id}`))) { completed = true; break; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      transcripts.push({ caseID: scenario.id, sessionID, records: messages });
      observations.push({ phase: completed ? 'scenario_settled' : 'scenario_timeout', caseID: scenario.id, at: Date.now() });
      assert.equal(completed, true, `Native ${scenario.id} provider continuation timed out`);
      await child.call({ action: 'complete' });
      if (options.sameFile) return messages.flatMap(message => message.parts ?? []).filter(part => part.type === 'tool' && part.callID?.startsWith(`native_${scenario.id}_`));
      const call = messages.flatMap(message => message.parts ?? []).find(part => part.type === 'tool' && part.callID === `native_${scenario.id}`);
      if (!options.parallel) assert.ok(call && ['completed', 'error'].includes(call.state?.status), 'Native tool did not settle');
      return call;
    };
    const invoke = async (scenario, flags = false) => { const options = typeof flags === 'boolean' ? { parallel: flags } : flags;
      await begin(scenario, options); return settle(scenario, options); };
    const read = await invoke({ id: 'read', tool: 'read', input: { path: 'seed.txt' } });
    assert.equal(read.state.status, 'completed');
    assert.match(read.state.output, /native-read-marker/);
    const readLease = await host.runtime.leaseForCall({ directory, sessionID: session.id, callID: 'native_read' });
    assert.equal(readLease?.direct, true); assert.equal(readLease?.executionKind, 'control'); assert.equal(readLease?.state, 'published');
    assert.equal(readLease?.result?.files.length, 0); assert.ok(readLease.result.operationID);
    cases.push({ id: 'native-read', status: 'passed', source: 'reviewed-direct-read-generation-fence' });
    assert.ok(capturedPrompt, 'Actual admitted native prompt seal was not observed');
    const staleBefore = (await client.sessions.messages(session.id, {}, { directory })).records.map(row => row.info.id);
    const staleBytes = await snapshotFiles(directory, ['seed.txt', 'sequential.txt']);
    const staleReceiptCount = receipts.length;
    const staleRequestedCount = observations.filter(row => row.phase === 'execution_requested').length;
    const stalePrompt = await fetch(capturedPrompt.url, { method: 'POST', body: capturedPrompt.body,
      headers: capturedPrompt.headers, signal: AbortSignal.timeout(10_000) });
    const staleResponse = await stalePrompt.json();
    const refusalCode = typeof staleResponse?.code === 'string' ? staleResponse.code.slice(0, 256) : null;
    observations.push({ phase: 'expired_admission_response', at: Date.now(), status: stalePrompt.status, code: refusalCode,
      ...(typeof staleResponse?.name === 'string' ? { name: staleResponse.name.slice(0, 256) } : {}),
      ...(typeof staleResponse?.message === 'string' ? { message: staleResponse.message.slice(0, 512) } : {}) });
    assert.deepEqual((await client.sessions.messages(session.id, {}, { directory })).records.map(row => row.info.id), staleBefore,
      'Expired native prompt seal admitted another user or tool message');
    assert.deepEqual(await snapshotFiles(directory, ['seed.txt', 'sequential.txt']), staleBytes);
    assert.equal(receipts.length, staleReceiptCount);
    assert.equal(observations.filter(row => row.phase === 'execution_requested').length, staleRequestedCount);
    assert.equal((await host.runtime.leaseForCall({ directory, sessionID: session.id, callID: 'native_read' })).result.operationID, readLease.result.operationID);
    observations.push({ phase: 'expired_admission_no_effects', at: Date.now(), unchanged: true });
    assert.equal(stalePrompt.status, 403);
    assert.equal(refusalCode, 'native_permit_invalid');
    capturedPrompt = undefined;
    cases.push({ id: 'native-expired-admission-refused', status: 'passed', source: 'actual-previously-admitted-prompt-seal' });
    const codeMode = await invoke({ id: 'code-mode-refused', tool: 'execute', deniedInventory: true, input: { code: 'return 1' } });
    assert.equal(codeMode.state.status, 'error');
    assert.match(codeMode.state.error, /^(?:DevRyan Code Mode is disabled|Unknown tool: execute|No tool named "execute" is currently available\. Please use a tool from the available tool list\.)$/,
      'Out-of-catalog Code Mode invocation failed outside its native executor fence');
    assert.equal(await host.runtime.leaseForCall({ directory, sessionID: session.id, callID: 'native_code-mode-refused' }), null);
    assert.equal(observations.some(row => row.callID === 'native_code-mode-refused' && row.phase === 'execution_requested'), false);
    cases.push({ id: 'native-code-mode-refused', status: 'passed', source: 'native-model-catalog-and-executor-refusal' });
    const grep = await invoke({ id: 'grep', tool: 'grep', input: { pattern: 'native-read-marker', include: 'seed.txt' } });
    assert.equal(grep.state.status, 'completed'); assert.match(grep.state.output, /native-read-marker/);
    assertTerminatedBeforeOutcome([...observations, { callID: 'native_grep', phase: 'read_result' }], 'native_grep', 'read_result');
    cases.push({ id: 'native-grep', status: 'passed', source: 'supervised-read-process' });
    const glob = await invoke({ id: 'glob', tool: 'glob', input: { pattern: 'seed.txt' } });
    assert.equal(glob.state.status, 'completed'); assert.match(glob.state.output, /(?:^|[/\\])seed\.txt(?:\s|$)/);
    assertTerminatedBeforeOutcome([...observations, { callID: 'native_glob', phase: 'read_result' }], 'native_glob', 'read_result');
    cases.push({ id: 'native-glob', status: 'passed', source: 'supervised-read-process' });
    for (const scenario of writerCases) {
      const files = ['sequential.txt', 'ambiguous.txt', 'missing.txt', 'delete-target.txt', 'removalfail-target.txt']; const before = await snapshotFiles(directory, files);
      const result = await invoke(scenario);
      assert.equal(result.state.status, scenario.failed ? 'error' : 'completed', `Native ${scenario.id}: ${result.state.error ?? 'unexpected state'}`);
      await assertWriterOutcome({ runtime: host.runtime, directory, sessionID: session.id, callID: `native_${scenario.id}`,
        observations, before, files, succeeded: !scenario.failed });
      for (const [file, expected] of Object.entries(scenario.expected ?? {})) assert.equal(await fs.readFile(path.join(directory, file), 'utf8'), expected);
      for (const file of scenario.removed ?? []) assert.equal((await snapshotFiles(directory, [file]))[file], null, 'Native removal failed to publish');
      cases.push({ id: scenario.id, status: 'passed' });
    }
    cases.push(...await runProtectedRootCases({ directory, sessionID: session.id, runtime: host.runtime, observations, invoke, protectedDirectory: home }));
    await invoke({ id: 'parallel-eight' }, true);
    for (let index = 0; index < 8; index++) {
      assert.equal(await fs.readFile(path.join(directory, `parallel-${index}.txt`), 'utf8'), `writer ${index}\n`);
      await assertWriterOutcome({ runtime: host.runtime, directory, sessionID: session.id, callID: `native_parallel-eight_${index}`, observations, succeeded: true });
    }
    const concurrent = new Set(); let peak = 0;
    for (const observation of observations.filter(record => record.callID?.startsWith('native_parallel-eight_'))) {
      if (observation.phase === 'execution_requested') { concurrent.add(observation.callID); peak = Math.max(peak, concurrent.size); }
      if (observation.phase === 'termination_verified') concurrent.delete(observation.callID);
    }
    assert.equal(peak, 8, 'Eight tool calls were serialized rather than concurrently owned');
    cases.push({ id: 'eight-concurrent-writers', status: 'passed' });
    cases.push(...await runWriterByteEdges({ directory, sessionID: session.id, runtime: host.runtime, observations, invoke, bun,
      configureFormatter: async formatter => { writerConfig.formatter = formatter;
        observations.push({ phase: 'formatter_configuration', sha256: hashNativeFixtureValue(formatter) }); } }));
    cases.push(await runInterruptedPublication({ directory, sessionID: session.id, runtime: host.runtime, observations, invoke,
      configureMaterialization: async hook => { materializeHook = hook; } }));
    cases.push(await runSameFileWriters({ client, setPermissions, begin, settle, runtime: host.runtime, directory, observations }));
    cases.push(await runForegroundShell({ invoke, runtime: host.runtime, directory, sessionID: session.id, observations }));
    cases.push(await runBackgroundShell({ invoke, runtime: host.runtime, directory, sessionID: session.id, observations }));
    cases.push(await runTrackedBackgroundShell({ invoke, client, managed, runtime: host.runtime, directory, observations }));
    cases.push(...await runPermissionCases({ client, setPermissions, begin, settle, runtime: host.runtime, directory, observations }));
    const assertCancelled = callID => assertNativeCancellationSettled({ databasePath: path.join(home, 'data/native.db'),
      environment: env, sessionID: session.id, callID, observations });
    cases.push(...await runCancelledWriterTransforms({ directory, sessionID: session.id, runtime: host.runtime, observations, begin, assertCancelled,
      executionHost: host, nativeControl: child, bun, configureFormatter: async formatter => { writerConfig.formatter = formatter;
        observations.push({ phase: 'formatter_configuration', sha256: hashNativeFixtureValue(formatter) }); } }));
    const deletionSession = await client.sessions.create({ title: 'Native deletion refusal', model: { providerID: 'sim', modelID: 'm1' } }, { directory });
    const deletionBytes = await snapshotFiles(directory, ['sequential.txt']);
    const receiptCountBeforeDeletion = receipts.length;
    await child.call({ action: 'hold', sessionID: deletionSession.id });
    assert.equal((await host.runtime.nativeAdmissionState({ directory, sessionID: deletionSession.id })).held, true);
    const deletion = await fetch(`${nativeUrl}/api/session/${encodeURIComponent(deletionSession.id)}`, {
      method: 'DELETE', headers: deps.getAuthHeaders(), signal: AbortSignal.timeout(10_000) });
    assert.equal(deletion.status, 403);
    assert.equal((await deletion.json()).code, 'native_owned_lifecycle_required');
    assert.equal((await client.sessions.get(deletionSession.id, { directory })).id, deletionSession.id);
    assert.equal((await host.runtime.nativeAdmissionState({ directory, sessionID: deletionSession.id })).held, true);
    assert.deepEqual(await snapshotFiles(directory, ['sequential.txt']), deletionBytes);
    assert.equal(receipts.length, receiptCountBeforeDeletion, 'Refused deletion published files');
    await child.call({ action: 'release', sessionID: deletionSession.id });
    cases.push({ id: 'native-held-deletion-refused', status: 'passed', source: 'native-owned-lifecycle-closed' });
    cases.push(await runEscapedDescendantCancellation({ begin, nativeControl: child, executionHost: host, runtime: host.runtime,
      directory, sessionID: session.id, observations, assertCancelled }));
    const recovery = await invoke({ id: 'after-cancel-write', tool: 'write', input: { path: 'after-cancel.txt', content: 'fresh after native cancellation\n' } });
    assert.equal(recovery.state.status, 'completed');
    await assertWriterOutcome({ runtime: host.runtime, directory, sessionID: session.id, callID: 'native_after-cancel-write', observations, succeeded: true });
    assert.equal(await fs.readFile(path.join(directory, 'after-cancel.txt'), 'utf8'), 'fresh after native cancellation\n');
    cases.push({ id: 'fresh-turn-after-cancel-release', status: 'passed' });
    cases.push(await runControllerCrashHold({ begin, invoke, restartNative, getNativeControl: () => child, admissionOwner: owner,
      executionHost: host, client, directory, sessionID: session.id, observations }));
    const managedCase = await managed.runAcceptance(child);
    cases.push(managedCase);
    trackedSessions.add(managedCase.rootSessionID);
    trackedSessions.add(managedCase.childSessionID);
    if (options.managedWakeAttribution) {
      const { runManagedWakeAttribution } = await import('./perf/managed-wake-attribution.mjs');
      managedWakeAttribution = await runManagedWakeAttribution({ client, managed, nativeControl: child, observations, directory,
        controlledPid: child.child.pid, readOperationCounts: () => nativeRequestCount + privateRpcCount,
        openEventStream: ({ url, signal }) => fetch(url, { headers: deps.getAuthHeaders(), signal }) });
      managedWakeAttribution.operationScope = 'actual-client-HTTP-requests-plus-private-bridge-RPC-calls';
      for (const arm of managedWakeAttribution.arms) {
        trackedSessions.add(arm.proof.rootSessionID); trackedSessions.add(arm.proof.childSessionID);
      }
    }
    cases.push(await runPendingBackgroundRestart({ begin, settle, restartNative, getNativeControl: () => child,
      admissionOwner: owner, executionHost: host, client, directory, sessionID: session.id, observations,
      databasePath: path.join(home, 'data/native.db'), environment: env }));
    const removalManagedCase = await managed.runAcceptance(child, { caseID: 'managed-removal', revert: false });
    trackedSessions.add(removalManagedCase.rootSessionID);
    trackedSessions.add(removalManagedCase.childSessionID);
    await runNativeRemovalCases({ client, admissionOwner: owner, ownerID, executionHost: host,
      managed, managedCase: removalManagedCase, begin, bun, directory, databasePath: path.join(home, 'data/native.db'), environment: env,
      observations, getNativeControl: () => child, restartNative, trackSession: sessionID => trackedSessions.add(sessionID),
      onPassedCase: row => cases.push(row),
      configureFormatter: async formatter => { writerConfig.formatter = formatter;
        observations.push({ phase: 'formatter_configuration', sha256: hashNativeFixtureValue(formatter) }); } });
  } catch (error) { runError = error; }
  finally {
    observations.push({ phase: 'cleanup_begin', at: Date.now() });
    const retainCleanupFailure = (error, message) => {
      runError = new AggregateError([...(runError ? [runError] : []), error], message);
    };
    let controllerStopped = !child, processesSettled = false;
    try { if (child) cleanup = await child.stop(); controllerStopped = true; }
    catch (error) { cleanup = error.evidence; retainCleanupFailure(error, 'Native acceptance cleanup failed'); }
    try { await managed.close(); } catch (error) { retainCleanupFailure(error, 'Managed runtime cleanup failed'); }
    try { await host.drain(); processesSettled = true; } catch (error) { retainCleanupFailure(error, 'Web ledger drain failed'); }
    if (controllerStopped && processesSettled) {
      try { await owner.invalidateController(); } catch (error) { retainCleanupFailure(error, 'Native acknowledgement drain failed'); }
      try { owner.dispose(); } catch (error) { retainCleanupFailure(error, 'Native admission owner cleanup failed'); }
    } else {
      observations.push({ phase: 'native_owner_cleanup_unsettled', controllerStopped, processesSettled });
    }
    try { await bridge.stop(); } catch (error) { retainCleanupFailure(error, 'Private bridge cleanup failed'); }
    try { await fs.rm(fixtureFile, { force: true }); } catch (error) { retainCleanupFailure(error, 'Private fixture cleanup failed'); }
    if (child) await fs.writeFile(path.join(root, 'native.log'), child.getLog());
  }
  const finalSource = await captureNativeAcceptanceSource();
  const finalArtifacts = await verifyNativeAcceptanceArtifacts(options);
  const changedPaths = [...new Set([...Object.keys(source.sources), ...Object.keys(finalSource.sources)])]
    .filter(file => source.sources[file] !== finalSource.sources[file]);
  const artifactDigest = hashNativeFixtureValue(artifacts), finalArtifactDigest = hashNativeFixtureValue(finalArtifacts);
  const cohort = { valid: changedPaths.length === 0 && artifactDigest === finalArtifactDigest,
    artifactDigest, finalArtifactDigest, finalSourceDigest: finalSource.sourceDigest, changedPaths };
  if (!cohort.valid && !runError) runError = Object.assign(new Error('Native acceptance source cohort changed during execution'), { code: 'native_acceptance_cohort_invalid' });
  const result = { lane: 'writers', mode: options.diagnostic ? 'diagnostic' : 'cohort', status: runError ? 'failed' : 'passed', root, artifacts, source, cohort, configurationSha256, managedDigest,
    cases, observations, receipts, diagnostics, transcripts, cleanup, controllerRestarts,
    ...(managedWakeAttribution ? { managedWakeAttribution } : {}),
    ...(runError ? { error: runError.message, stack: runError.stack, errorEvidence: errorEvidence(runError) } : {}),
    remainingMandatoryGate: (() => {
      const passed = new Set(cases.filter(row => row.status === 'passed').map(row => row.id));
      const groups = [
        ['native writer transforms/removal', writerCases.map(row => row.id)],
        ['protected native read/preview boundaries', ['protected-read', 'protected-grep', 'protected-glob', 'protected-writer-preview', 'protected-writer-symlink', 'protected-writer-git']],
        ['eight concurrent native writers', ['eight-concurrent-writers']],
        ['formatter/BOM/CRLF/foreign changes/same-file conflict', ['bom-crlf-edit', 'repeated-patch-formatter', 'foreign-retained-match', 'foreign-removed-match', 'same-file-writers']],
        ['foreground/background shell', ['foreground-shell', 'background-shell']],
        ['tracked primary background continuation', ['tracked-primary-background']],
        ['permissions', ['permission-deny', 'permission-ask-reject', 'permission-ask-correction']],
        ['native write/edit cancellation during transformation', ['cancel-write-transform', 'cancel-edit-transform']],
        ['positive supervised native glob', ['native-glob']],
        ['Code Mode structural absence', ['native-code-mode-refused']],
        ['native held deletion refusal', ['native-held-deletion-refused']],
        ['native stale admission', ['native-expired-admission-refused']],
        ['pending background startup recovery without duplicate continuation', ['pending-background-native-marker-restart']],
        ['cancel/escaped descendants', ['escaped-descendant-cancel', 'fresh-turn-after-cancel-release']],
        ['interrupted publication/restart holds', ['interrupted-publication', 'controller-crash-durable-hold-restart']],
        ['managed child/parent continuation', ['managed-child-parent-continuation']],
        ['owned stable-subtree removal and recovery', ['native-owned-active-writer-removal', 'native-owned-managed-pending-disposition',
          'native-owned-child-create-removal-race', 'native-owned-removal-commit-restart']],
      ];
      const remaining = groups.filter(([, ids]) => ids.some(id => !passed.has(id))).map(([label]) => label);
      if (!cases.some(row => row.conversationRevertRedo?.status === 'passed')) remaining.push('conversation Revert/Redo');
      // Diagnostic results retain the final cohort gate even when their
      // implemented lanes complete on a source-stable tree.
      if (options.diagnostic || !cohort.valid) remaining.push('final source-stable acceptance cohort');
      return remaining;
    })() };
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
  run.finish(runError ? 'failed' : 'passed');
  if (runError) throw Object.assign(runError, { artifact: path.join(root, 'result.json') });
  return result;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2).filter(argument => argument !== '--keep-artifacts');
    assert.ok(args.length === 0 || args.length === 1 && args[0] === '--managed-wake-attribution',
      'Usage: node scripts/verify-opencode-v2-native.mjs [--managed-wake-attribution]');
    const result = await runNativeWriterAcceptance({ managedWakeAttribution: args.length === 1 });
    console.log(JSON.stringify({ lane: result.lane, status: result.status, cases: result.cases.length, artifact: path.join(result.root, 'result.json'), remainingMandatoryGate: result.remainingMandatoryGate }));
  } catch (error) { console.error(JSON.stringify({ status: 'failed', error: error.message, artifact: error.artifact })); process.exitCode = 1; }
}
