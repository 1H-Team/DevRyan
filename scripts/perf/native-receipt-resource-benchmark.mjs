import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { prepareRuntimeUiProfile, runtimeUiToolPrompt, runtimeUiTuple, createRuntimeUiResponder } from '../qa/native-backend-ui-diagnostic.mjs';
import { loadQaPackagedArtifact } from '../qa/packaged-artifact.mjs';
import { captureQaSourceIdentity } from '../qa/artifact-evidence.mjs';
import { readQa1NativeQualification } from '../qa/qa1-profile-exercise.mjs';
import { readQa1ProviderJournal } from '../qa/qa1-provider-qualification.mjs';
import { readRuntimeBundleBinding } from '../../packages/web/server/lib/opencode/runtime-host/runtime-bundle-binding.js';
import { createRunRoot } from '../qa/run-root.mjs';
import { reservePort, startOwnedProcess } from '../qa/process.mjs';
import { createQaHostLaunchEnvironment } from '../qa/launch-environment.mjs';
import { waitForQaHostReady } from '../qa/host-readiness.mjs';
import { readQaProcessSnapshot } from '../qa/process-ownership.mjs';
import { CdpConnection, discoverPageTarget, evaluate } from '../qa/cdp.mjs';
import { createQaUiDriver } from '../qa/ui-driver.mjs';
import { observeNativeStartupSubscription, readNativeStartupLogs } from '../qa/native-startup-benchmark.mjs';
import { captureFirstDocumentStartup, observeStartupNavigation, parseStartupPhaseLogs } from './electron-lifecycle-benchmark.mjs';
import { captureBenchmarkSource, createProcessSampler } from './native-upgrade-benchmark.mjs';
import { collectFootprint } from './multi-session-sampler.mjs';
import { startReceiptSettlementProbe, finishReceiptSettlementProbe, closeReceiptSettlementProbe, joinReceiptSettlement, summarizeReceiptSettlements } from './receipt-ui-settlement.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const script = fileURLToPath(import.meta.url), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const requireElectron = createRequire(path.join(repository, 'packages/electron/package.json'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const finite = value => Number.isSafeInteger(value) && value >= 0;
export const PAIR_PROTOCOL = Object.freeze({ pairs: 5, turns: ['fresh', 'repeat'], sampleIntervalMs: 250, turnTimeoutMs: 90000,
  hostScope: 'unpackaged actual web/native harness plus sandboxed Electron Chromium; packaged UI bytes, not packaged shell execution',
  variantMeaning: 'High is the canonical/native-prepared selection; synthetic fixture configuration uses temperature 0, with no wire reasoning-effort claim',
  fresh: 'first native objective in a fresh app/profile/workspace ledger',
  repeat: 'identical objective in a new session on the same running app/profile; only the owned output is reset to absent',
  startupPrewarm: 'normal production startup prewarm remains enabled; first turn does not imply untouched caches',
  excluded: ['cold OS or disk caches', 'paid-provider latency', 'historical before/after improvement', 'exact total durable commit count', 'every short-lived process'] });

export function parseReceiptResourceArgs(argv) {
  const keys = ['--package-evidence', '--artifact-root', '--qualification-report'];
  assert.equal(argv.length, 6, 'Required: --package-evidence <absolute> --artifact-root <absolute> --qualification-report <absolute>');
  const out = {};
  for (const [index, key] of keys.entries()) {
    assert.equal(argv[index * 2], key); const value = argv[index * 2 + 1];
    assert.ok(path.isAbsolute(value) && path.resolve(value) === value && value.startsWith(repository + '/.cache/'), 'Inputs must be repository-owned cache paths');
    out[['packageEvidence', 'artifactRoot', 'qualificationReport'][index]] = value;
  }
  return out;
}

/** Existing footprint owner, fenced on both sides by retained OS start identities. */
export async function sampleFencedFootprint(identities, file, { snapshot = readQaProcessSnapshot, collect = collectFootprint } = {}) {
  const before = new Map((await snapshot()).map(row => [row.pid, row]));
  const eligible = identities.filter(row => before.get(row.pid)?.running && before.get(row.pid).startIdentity === row.startIdentity);
  if (eligible.length > 80) return { status: 'gap', reason: 'footprint-process-bound' };
  const startedAt = Date.now(), values = await collect(eligible.map(row => row.pid), file);
  const after = new Map((await snapshot()).map(row => [row.pid, row]));
  const rows = eligible.filter(row => after.get(row.pid)?.running && after.get(row.pid).startIdentity === row.startIdentity
    && Number.isFinite(values.get(row.pid)?.footprint) && values.get(row.pid).footprint > 0)
    .map(row => ({ pid: row.pid, startIdentity: row.startIdentity, footprintBytes: values.get(row.pid).footprint }));
  return { status: rows.length === identities.length && rows.length > 0 ? 'observed' : 'gap', startedAt, endedAt: Date.now(),
    required: identities.length, observed: rows.length, rows, totalFootprintBytes: rows.reduce((sum, row) => sum + row.footprintBytes, 0) };
}

export function projectResourceCounters({ journal, timing, objectiveID, sessionID, decodedRequestBytes, publication }) {
  const rows = journal.records.filter(row => row.sessionID === sessionID);
  const native = rows.filter(row => row.type === 'native'), physical = native.filter(row => row.stage === 'physical' && row.kind === 'primary');
  const records = timing?.records?.filter(row => row.sessionId === sessionID && row.userMessageId === objectiveID) ?? [];
  const bridge = records.length === 1 ? records[0].diagnostics?.bridge : null;
  return { preparedPrimaryRequests: native.filter(row => row.stage === 'model-prepared' && row.kind === 'primary').length, physicalPrimarySends: physical.length,
    providerBodyBytes: rows.filter(row => row.type === 'body-end').reduce((sum, row) => sum + row.bytes, 0),
    decodedReencodedProviderRequestBytes: decodedRequestBytes,
    bridgeRPC: finite(bridge?.count) && finite(bridge.failedCount) ? { status: 'observed', count: bridge.count, failedCount: bridge.failedCount }
      : { status: 'gap', reason: 'exact-turn-bridge-counter-unavailable' },
    requiredPublishedWriteReceipts: publication?.termination?.terminated === true && publication.termination.confined === true && publication.termination.exitCode === 0 ? 1 : 0,
    nativeFinishBoundaries: rows.filter(row => row.type === 'receipt-boundary' && row.state === 'completed' && ['finish', 'direct_finish'].includes(row.phase)).length,
    totalDurableCommits: { status: 'gap', reason: 'existing-finish-and-ledger-lock-counters-do-not-count-every-durable-commit' } };
}

export function projectJournalBridgeTiming(records, { sessionID, objectiveID, assistantID, since, until }) {
  assert.ok(finite(since) && finite(until) && since <= until);
  assert.ok(!records.some(row => row.type === 'gap' || row.event === 'native_observation_gap'));
  const rows = records.filter(row => row.type === 'turn-summary' && row.sessionID === sessionID
    && row.messageID === objectiveID && finite(row.at) && row.at >= since && row.at <= until);
  assert.equal(rows.length, 1, 'Exactly one original objective timing summary is required');
  const row = rows[0], bridge = row.bridge;
  assert.equal(row.assistantMessageID, assistantID, 'Timing summary must name the final canonical assistant');
  assert.ok(finite(bridge?.count) && finite(bridge.failedCount) && bridge.failedCount <= bridge.count);
  return { records: [{ sessionId: sessionID, userMessageId: objectiveID, diagnostics: { bridge: { count: bridge.count, failedCount: bridge.failedCount } } }] };
}

export function createBenchmarkLifetime(cleanup) {
  const pending = new Set(); let closed = false, stopping;
  const check = () => assert.equal(closed, false, 'Benchmark owner stopped');
  return { check, stage: async (action, adopt = () => {}) => {
    check(); const work = Promise.resolve().then(action).then(value => { adopt(value); return value; }); pending.add(work);
    try { const value = await work; check(); return value; } finally { pending.delete(work); }
  }, stop: () => { closed = true; return stopping ??= (async () => { await Promise.allSettled([...pending]); await cleanup(); })(); } };
}

export function createDeadlineCDP(cdp, deadline, { now = () => performance.now(), check = () => {} } = {}) {
  const assertLive = () => { check(); assert.ok(now() < deadline, 'Native receipt turn deadline'); };
  return { send: async (method, params, options = {}) => {
    assertLive(); const value = await cdp.send(method, params, { ...options, timeoutMs: Math.max(1, Math.min(options.timeoutMs ?? 10000, deadline - now())) });
    assertLive(); return value;
  } };
}

export async function captureReceiptFailureState(cdp) {
  return evaluate(cdp, `(async()=>{
    const s=window.__qaReceiptSettlement,input=s?.input;
    if(!input)return {status:'gap',reason:'receipt-probe-unavailable'};
    const query='?directory='+encodeURIComponent(input.directory),base='/api/session/';
    const replies=await Promise.all([fetch(base+encodeURIComponent(input.sessionID)+'/message'+query+'&limit=200',{signal:AbortSignal.timeout(1000)}),
      fetch(base+'status'+query,{signal:AbortSignal.timeout(1000)})]);
    if(replies.some(r=>!r.ok))return {status:'gap',reason:'canonical-read-unavailable'};
    const [rows,statuses]=await Promise.all(replies.map(r=>r.json()));
    if(!Array.isArray(rows)||rows.length>=200)return {status:'gap',reason:'canonical-inventory-incomplete'};
    const users=rows.filter(r=>r.info?.role==='user'),assistants=rows.filter(r=>r.info?.role==='assistant');
    const ids=rows=>rows.map(r=>r.info.id).filter(id=>/^[A-Za-z0-9_:/.-]{1,256}$/.test(id));
    const visible=e=>Boolean(e?.isConnected&&e.getBoundingClientRect().height>0);
    const composer=document.querySelector('textarea'),send=document.querySelector('button[aria-label="Send Message"]');
    const action=s.probe.snapshot().actions.find(r=>r.id===s.job),type=statuses[input.sessionID]?.type;
    return {status:'observed',sessionID:input.sessionID,userIDs:ids(users),assistantIDs:ids(assistants),
      completeAssistants:assistants.filter(r=>r.info.time?.completed).length,errorAssistants:assistants.filter(r=>r.info.error).length,
      statusPresent:Object.hasOwn(statuses,input.sessionID),statusType:['idle','busy','retry'].includes(type)?type:'missing-or-unknown',
      selected:new URL(location.href).searchParams.get('session')===input.sessionID,documentVisible:document.visibilityState==='visible',
      rendered:visible(document.querySelector('[data-message-id="'+assistants.at(-1)?.info.id+'"]')),
      composerVisible:visible(composer),composerEnabled:Boolean(composer&&!composer.disabled),sendVisible:visible(send),sendEnabled:Boolean(send&&!send.disabled),
      stopVisible:visible(document.querySelector('button[aria-label="Stop Generating"]')),actionOutcome:['passed','failed'].includes(action?.outcome)?action.outcome:'pending'};
  })()`, { timeoutMs: 3000 });
}

export function summarizeNativePairs(pairs) {
  const valid = pairs.length === 5 && pairs.every((pair, index) => pair.pair === index + 1 && pair.cleanup?.complete === true
    && pair.turns.length === 2 && pair.turns.every((turn, at) => turn.condition === PAIR_PROTOCOL.turns[at]
      && turn.publication?.termination?.terminated === true && turn.publication.termination.confined === true
      && turn.publication.termination.exitCode === 0 && turn.settlement?.status === 'matched'
      && Array.isArray(turn.resources?.failures) && turn.resources.failures.length === 0 && turn.resources?.samples?.length > 0
      && turn.resources.processOwnership?.controlledRuntimePid === pair.runtimeIdentity?.pid
      && turn.resources.processOwnership.observedProcesses.some(row => row.pid === pair.runtimeIdentity.pid && row.startIdentity === pair.runtimeIdentity.startIdentity)
      && turn.resources.processOwnership.observedProcesses.some(row => row.pid === pair.browserIdentity?.pid && row.startIdentity === pair.browserIdentity.startIdentity)
      && turn.footprint?.status === 'observed' && turn.counters?.bridgeRPC?.status === 'observed'
      && turn.counters.bridgeRPC.failedCount === 0 && turn.counters.requiredPublishedWriteReceipts === 1));
  const summaries = Object.fromEntries(PAIR_PROTOCOL.turns.map(condition => [condition,
    summarizeReceiptSettlements(pairs.flatMap(pair => pair.turns.filter(turn => turn.condition === condition).map(turn => turn.settlement)))]));
  return { status: valid && new Set(pairs.map(pair => `${pair.runtimeIdentity.pid}\0${pair.runtimeIdentity.startIdentity}`)).size === 5
    && new Set(pairs.map(pair => `${pair.browserIdentity.pid}\0${pair.browserIdentity.startIdentity}`)).size === 5
    && Object.values(summaries).every(row => row.status === 'measured') ? 'measured' : 'gap',
    pairCount: pairs.length, receiptSettlement: summaries, historicalImprovementClaim: false, totalDurableCommitCountQualified: false };
}

/** Failure evidence is finite: never retain arbitrary assertion text or stacks. */
export function projectReceiptResourceFailure(error, stage) {
  const turnStage = /^(fresh|repeat)(?::(?:cohort|output-reset|session-create|navigation|composer-ready|probe-start|sampler-start|prompt-send|renderer-settlement|resources|canonical|publication|diagnostics-flush|diagnostics-status|journal|turn-summary|receipt-join|counters))?$/;
  const assertionReasons = new Map([
    ['Host clock stepped during calibration', 'receipt-clock-host-step'],
    ['Renderer wall clock differs from journal host', 'receipt-clock-renderer-offset'],
    ['Native receipt turn deadline', 'turn-deadline'],
  ]);
  return { stage: ['admission', 'prepare', 'startup'].includes(stage) || turnStage.test(stage) ? stage : 'unknown',
    errorName: ['Error', 'TypeError', 'RangeError', 'AssertionError', 'AggregateError'].includes(error?.name) ? error.name : 'OtherError',
    ...(Number.isInteger(error?.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599 ? { httpStatus: error.httpStatus } : {}),
    code: /^[a-z][a-z0-9_]{1,100}$/.test(error?.code ?? '') ? error.code : 'native_receipt_resource_incomplete',
    reason: error?.code === 'ERR_ASSERTION' ? assertionReasons.get(error.message) ?? 'assertion-failed' : 'owner-operation-failed' };
}

export async function rendererRequest(cdp, route, options = {}) {
  const result = await evaluate(cdp, `(async()=>{const response=await fetch(${JSON.stringify(route)},{method:${JSON.stringify(options.method ?? 'GET')},
    headers:{'content-type':'application/json','X-DevRyan-CSRF':'1'},${options.body ? `body:${JSON.stringify(JSON.stringify(options.body))},` : ''}
    signal:AbortSignal.timeout(10000)});if(!response.ok)return {ok:false,status:response.status};
    ${options.discard ? 'await response.body?.cancel();return {ok:true,value:{ok:true}};' : 'return {ok:true,value:await response.json()};'}})()`);
  if (result?.ok !== true) throw Object.assign(Error('Owned API refused'), { code: 'native_receipt_api_refused',
    ...(Number.isInteger(result?.status) && result.status >= 100 && result.status <= 599 ? { httpStatus: result.status } : {}) });
  return result.value;
}

async function runPair({ pair, root, packaged, browserBinary, artifactRoot, cohort, check, onStop, record: result }) {
  const runtimeRoot = path.join(root, 'runtime', `pair-${pair}`), workspace = path.join(runtimeRoot, 'workspace');
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(workspace, 'src/tasks.mjs'), 'export const task = "fixed synthetic receipt resource workload";\n', { flag: 'wx' });
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', '--template=', workspace], { env: { PATH: process.env.PATH, HOME: runtimeRoot, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  let prepared, app, browser, cdp, subscription, navigation, sampler;
  let decodedRequestBytes = 0;
  const lifetime = createBenchmarkLifetime(async () => {
    const failures = []; for (const action of [() => sampler?.stop(), () => cdp ? closeReceiptSettlementProbe(cdp) : undefined,
      () => { subscription?.close(); navigation?.complete(); cdp?.close(); }, () => browser?.stop(), () => app?.stop(), () => prepared?.close(),
      () => browser?.auditStopped(), () => app?.auditStopped()]) {
      try { await action(); } catch { failures.push('owned-cleanup-unconfirmed'); }
    }
    result.cleanup = { complete: failures.length === 0, failures };
  });
  const stop = lifetime.stop;
  onStop(stop);
  try {
    result.stage = 'prepare';
    const responder = createRuntimeUiResponder({ generation: 2, directory: workspace });
    await lifetime.stage(() => prepareRuntimeUiProfile({ cell: { transport: 'runtime-fixture' }, runtimeRoot, workspace, targetGeneration: 2, artifactRoot,
      packetDelayMs: 80, fixtureResponder: request => { decodedRequestBytes += Buffer.byteLength(JSON.stringify(request.body)); return responder(request); } }), value => { prepared = value; });
    const binding = readRuntimeBundleBinding({ DEVRYAN_RUNTIME_BUNDLE_ROOT: prepared.controlRoot });
    const webData = binding.descriptor.launch.webDataDirectory;
    const port = await reservePort(), debugPort = await reservePort(), profile = path.join(runtimeRoot, 'browser-profile');
    const origin = `http://127.0.0.1:${port}`, startedAt = performance.now();
    const env = createQaHostLaunchEnvironment(prepared.env, { DEVRYAN_QA_RUNTIME: 'web', OPENCHAMBER_PORT: String(port),
      OPENCHAMBER_DIST_DIR: packaged.artifactDirectory, DEVRYAN_EXECUTION_SUMMARY_MIN_MS: '0', OPENCHAMBER_ELECTRON_USER_DATA_DIR: profile });
    delete env.NODE_OPTIONS; delete env.ELECTRON_RUN_AS_NODE;
    await lifetime.stage(() => startOwnedProcess(process.execPath, [prepared.bootstrapPath], { cwd: repository, env }), value => { app = value; });
    result.stage = 'startup';
    await waitForQaHostReady({ origin, checkAlive: () => { lifetime.check(); app.check(); } });
    await lifetime.stage(() => startOwnedProcess(browserBinary, [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
      '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling',
      'scripts/qa/browser-shell.cjs'], { cwd: repository, env: { ...env, DEVRYAN_QA_ORIGIN: origin } }), value => { browser = value; });
    const target = await discoverPageTarget(debugPort);
    await lifetime.stage(() => CdpConnection.connect(target.webSocketDebuggerUrl), value => { cdp = value; });
    navigation = observeStartupNavigation(cdp, startedAt, target.url); subscription = observeNativeStartupSubscription(cdp, startedAt, origin);
    await Promise.all([cdp.send('Page.enable'), cdp.send('Runtime.enable'), cdp.send('Network.enable')]);
    const startup = await captureFirstDocumentStartup({ cdp, origin, startedAt, startupMode: 'foreground', navigationAudit: navigation,
      readStartupPhases: () => parseStartupPhaseLogs(readNativeStartupLogs(app, prepared.env.DEVRYAN_QA_HOME)),
      runtimeUiTuple: { providerId: runtimeUiTuple.providerID, modelId: runtimeUiTuple.modelID, agent: 'builder' },
      checkAlive: () => { lifetime.check(); app.check(); browser.check(); subscription.check(); }, isEventStreamReady: subscription.isReady });
    result.startup = { outcome: startup.outcome, phases: startup.electronStartupPhases };
    if (startup.outcome !== 'passed') throw Object.assign(Error('Native receipt startup failed'), {
      code: startup.electronStartupPhases?.records?.findLast(row => row.outcome === 'failed')?.code ?? 'native_receipt_startup_failed' });
    assert.equal(new URL(startup.document.href).origin, origin, 'Startup document must use the exact owned origin');
    assert.equal(prepared.evidence.providerRequests.length, 0, 'Fresh turn must be the first provider request');
    const query = `?directory=${encodeURIComponent(workspace)}`;
    for (const condition of PAIR_PROTOCOL.turns) {
      result.stage = condition + ':cohort';
      await check(); lifetime.check(); app.check(); browser.check();
      assert.deepEqual(readRuntimeBundleBinding({ DEVRYAN_RUNTIME_BUNDLE_ROOT: prepared.controlRoot }).selection, binding.selection, 'Selected native revision changed');
      const deadline = performance.now() + PAIR_PROTOCOL.turnTimeoutMs;
      const turnCDP = createDeadlineCDP(cdp, deadline, { check: () => { lifetime.check(); app.check(); browser.check(); } });
      const ui = createQaUiDriver(turnCDP, { deadline, checkAlive: () => { lifetime.check(); app.check(); browser.check(); }, timeoutMs: PAIR_PROTOCOL.turnTimeoutMs });
      const request = (route, options) => rendererRequest(turnCDP, route, options);
      if (condition === 'repeat') {
        result.stage = condition + ':output-reset';
        await fs.unlink(path.join(workspace, 'runtime-ui-proof.txt'));
      }
      result.stage = condition + ':session-create';
      const session = await request('/api/session' + query, { method: 'POST', body: { title: 'Fixed native receipt resource workload', agent: 'builder', model: { providerID: runtimeUiTuple.providerID, modelID: runtimeUiTuple.modelID } } });
      result.stage = condition + ':navigation';
      await turnCDP.send('Page.navigate', { url: `${origin}/?session=${encodeURIComponent(session.id)}` });
      result.stage = condition + ':composer-ready';
      await ui.waitExpression('owned composer ready', 'Boolean(document.querySelector("textarea"))');
      const since = Date.now(), bytesBefore = decodedRequestBytes, requestsBefore = prepared.evidence.providerRequests.length;
      const wait = async action => { for (;;) { lifetime.check(); app.check(); browser.check(); assert.ok(performance.now() < deadline, 'Native receipt turn deadline');
        const value = await action(); assert.ok(performance.now() < deadline, 'Native receipt turn deadline'); if (value) return value; await pause(100); } };
      result.stage = condition + ':probe-start';
      const probe = await startReceiptSettlementProbe({ cdp: turnCDP, sessionID: session.id, directory: workspace, previousUserIDs: [], timeoutMs: Math.max(1, Math.floor(deadline - performance.now())) });
      result.stage = condition + ':sampler-start';
      await lifetime.stage(() => createProcessSampler(app.child.pid), value => { sampler = value; });
      result.stage = condition + ':prompt-send';
      await ui.send(runtimeUiToolPrompt);
      result.stage = condition + ':renderer-settlement';
      const observation = await finishReceiptSettlementProbe({ cdp: turnCDP, ...probe, wait });
      result.stage = condition + ':resources';
      const resources = await lifetime.stage(() => sampler.stop()); sampler = null;
      const runtimeIdentity = resources.processOwnership.observedProcesses.find(row => row.pid === app.child.pid);
      assert.ok(runtimeIdentity?.startIdentity); result.runtimeIdentity ??= { pid: runtimeIdentity.pid, startIdentity: runtimeIdentity.startIdentity };
      const browserIdentity = resources.processOwnership.observedProcesses.find(row => row.pid === browser.child.pid);
      assert.ok(browserIdentity?.startIdentity); result.browserIdentity ??= { pid: browserIdentity.pid, startIdentity: browserIdentity.startIdentity };
      const footprint = await lifetime.stage(() => sampleFencedFootprint(resources.samples.at(-1).processes,
        path.join(root, 'runtime', `footprint-${pair}-${condition}.json`)));
      result.stage = condition + ':canonical';
      const rows = await request(`/api/session/${session.id}/message${query}&limit=200`);
      const users = rows.filter(row => row.info?.role === 'user'); assert.equal(users.length, 1); const user = users[0];
      assert.equal(user.info.agent, 'builder'); assert.equal(user.info.model.providerID, runtimeUiTuple.providerID);
      assert.equal(user.info.model.modelID, runtimeUiTuple.modelID); assert.equal(user.info.model.variant ?? user.info.variant, 'high');
      result.stage = condition + ':publication';
      const publication = await prepared.verifyToolPublication({ rows, sessionID: session.id });
      result.stage = condition + ':diagnostics-flush';
      await request('/api/diagnostics/export', { method: 'POST', body: { scope: 'runtime', format: 'chrome-trace' }, discard: true });
      result.stage = condition + ':diagnostics-status';
      const status = await request('/api/diagnostics/status'); assert.equal(status.directory, path.join(webData, 'harness/journal'));
      result.stage = condition + ':journal';
      const journal = await readQa1ProviderJournal({ runtimeRoot: webData, journalDirectory: status.directory,
        coverage: { enabled: status.enabled, gapRecords: status.gapRecords, queuedRecords: status.queuedRecords, lastError: Boolean(status.lastError) },
        sessionIDs: [session.id], directory: workspace, since, until: Date.now(), receiptSettlement: true });
      const preparedPrimary = journal.records.filter(row => row.type === 'native' && row.stage === 'model-prepared' && row.kind === 'primary');
      assert.ok(preparedPrimary.length > 0 && preparedPrimary.every(row => row.execution?.variant === 'high'));
      result.stage = condition + ':turn-summary';
      assert.ok(journal.complete === true && journal.gapCount === 0);
      const timing = projectJournalBridgeTiming(journal.records, { sessionID: session.id, objectiveID: user.info.id,
        assistantID: rows.filter(row => row.info?.role === 'assistant' && row.info.parentID === user.info.id).at(-1)?.info.id,
        directory: workspace, since, until: Date.now() });
      result.stage = condition + ':receipt-join';
      const settlement = joinReceiptSettlement({ journal, rows, sessionID: session.id, objectiveID: user.info.id, probe: observation, cohort });
      result.stage = condition + ':counters';
      const counters = projectResourceCounters({ journal, timing, objectiveID: user.info.id, sessionID: session.id, decodedRequestBytes: decodedRequestBytes - bytesBefore, publication });
      counters.loopbackProviderRequests = prepared.evidence.providerRequests.length - requestsBefore;
      result.turns.push({ condition, sessionID: session.id, objectiveID: user.info.id, resources, footprint, publication, settlement,
        journalCoverage: { complete: journal.complete, gapCount: journal.gapCount, projectedRecords: journal.records.length },
        counters });
      assert.equal(counters.loopbackProviderRequests, counters.physicalPrimarySends, 'Unattributable/background provider requests');
      assert.equal(settlement.status, 'matched', settlement.reason); assert.equal(footprint.status, 'observed', 'Footprint identity/coverage gap');
      assert.deepEqual(resources.failures, []); await prepared.verifyInputs();
      assert.deepEqual(readRuntimeBundleBinding({ DEVRYAN_RUNTIME_BUNDLE_ROOT: prepared.controlRoot }).selection, binding.selection);
    }
  } catch (error) {
    if (cdp) result.rendererFailure = await captureReceiptFailureState(cdp).catch(() => ({ status: 'gap', reason: 'failure-projection-unavailable' }));
    throw error;
  } finally { await stop(); onStop(async () => {}); }
  assert.equal(result.cleanup.complete, true, 'Owned cleanup unconfirmed'); return result;
}

export async function runNativeReceiptResourceBenchmark(options) {
  assert.ok(process.platform === 'darwin' && process.arch === 'arm64', 'Requires isolated Darwin ARM64 native/packaged artifacts');
  const packaged = await loadQaPackagedArtifact({ root: repository, evidencePath: options.packageEvidence });
  const serverSourceSha256 = (await captureQaSourceIdentity(repository)).sha256;
  assert.equal(serverSourceSha256, packaged.evidence.source.sha256, 'Current web/native host source must match packaged provenance');
  const manifestBytes = await fs.readFile(path.join(options.artifactRoot, 'native-bundle.json')), manifest = JSON.parse(manifestBytes);
  const selected = { buildID: manifest.buildId, artifactManifestSha256: hash(manifestBytes) };
  const qualification = await readQa1NativeQualification(options.qualificationReport, selected);
  const browserBinary = requireElectron('electron'), browserSha256 = hash(await fs.readFile(browserBinary));
  const packagedManifest = await fs.readFile(path.join(packaged.evidence.appPath, 'Contents/Resources/revert-runtime/darwin-arm64/native-bundle.json'));
  assert.equal(hash(packagedManifest), selected.artifactManifestSha256, 'App and qualified native artifact must match');
  const source = await captureBenchmarkSource(), runnerSha256 = hash(await fs.readFile(script));
  const cohort = { ...selected, sourceDigest: source.sourceDigest, serverSourceSha256, runnerSha256, browserSha256,
    browserVersion: requireElectron('electron/package.json').version, hostScope: PAIR_PROTOCOL.hostScope, uiSha256: packaged.evidence.packagedWebArtifact.sha256,
    workload: hash(runtimeUiToolPrompt), agent: 'builder', providerID: runtimeUiTuple.providerID, modelID: runtimeUiTuple.modelID, variant: 'high',
    archiveSha256: packaged.evidence.archiveSha256, qualificationReportSha256: qualification.reportSha256,
    packageEvidenceSha256: hash(await fs.readFile(options.packageEvidence)) };
  for (const file of ['scripts/perf/native-receipt-resource-benchmark.mjs', 'scripts/perf/multi-session-sampler.mjs', 'scripts/perf/native-upgrade-benchmark.mjs',
    'scripts/perf/receipt-ui-settlement.mjs', 'scripts/qa/process-ownership.mjs']) assert.ok(source.sources[file], 'Transitive measurement owner missing from source pin');
  let stop = async () => {}; const run = createRunRoot({ parent: path.join(repository, '.cache/perf'), prefix: 'native-receipt-resource-',
    owner: 'scripts/perf/native-receipt-resource-benchmark.mjs', onInterrupt: () => stop() });
  const result = { schemaVersion: 1, status: 'failed', protocol: PAIR_PROTOCOL, cohort, source, pairs: [],
    measurement: { hostScope: PAIR_PROTOCOL.hostScope, resourceScope: 'synthetic loopback responder/collector Node plus owned web/native and Electron browser descendants', footprintScope: 'surviving retained descendants at settled turn boundary',
      limitations: ['coarse OS observations miss short-lived children', 'footprint snapshots do not resolve UI thresholds', 'receipt timestamps retain commit/clock intervals', 'RPC counter excludes calls outside the observed active turn'] } };
  const check = async () => { assert.deepEqual(await captureBenchmarkSource(), source, 'Frozen benchmark sources changed');
    assert.equal((await captureQaSourceIdentity(repository)).sha256, cohort.serverSourceSha256);
    assert.equal((await readQa1NativeQualification(options.qualificationReport, selected)).reportSha256, cohort.qualificationReportSha256);
    const current = await loadQaPackagedArtifact({ root: repository, evidencePath: options.packageEvidence });
    assert.equal(current.evidence.archiveSha256, cohort.archiveSha256); assert.equal(current.evidence.packagedWebArtifact.sha256, cohort.uiSha256);
    assert.equal(hash(await fs.readFile(options.packageEvidence)), cohort.packageEvidenceSha256);
    assert.equal(hash(await fs.readFile(browserBinary)), cohort.browserSha256);
    assert.equal(hash(await fs.readFile(path.join(options.artifactRoot, 'native-bundle.json'))), selected.artifactManifestSha256); };
  try {
    for (let pair = 1; pair <= 5; pair++) {
      const record = { pair, turns: [], stage: 'admission', cleanup: { complete: false } }; result.pairs.push(record); await check();
      await runPair({ pair, root: run.dir, packaged, browserBinary, artifactRoot: options.artifactRoot, cohort, check, record, onStop: value => { stop = value; } });
    }
    result.summary = summarizeNativePairs(result.pairs); assert.equal(result.summary.status, 'measured', 'Five exact complete pairs required');
    await check(); assert.equal((await loadQaPackagedArtifact({ root: repository, evidencePath: options.packageEvidence })).evidence.archiveSha256, cohort.archiveSha256);
    result.status = 'measured';
  } catch (error) { result.failure = projectReceiptResourceFailure(error, result.pairs.at(-1)?.stage ?? 'admission'); }
  finally { await stop(); await fs.writeFile(path.join(run.dir, 'result.json'), JSON.stringify(result, null, 2) + '\n'); run.finish(result.status === 'measured' ? 'passed' : 'failed'); }
  return { status: result.status, output: run.dir, summary: result.summary, qualificationClaim: false };
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  runNativeReceiptResourceBenchmark(parseReceiptResourceArgs(process.argv.slice(2))).then(result => {
    process.stdout.write(JSON.stringify(result) + '\n'); if (result.status !== 'measured') process.exitCode = 1;
  }).catch(() => { process.stderr.write('native_receipt_resource_admission_failed\n'); process.exitCode = 1; });
}
