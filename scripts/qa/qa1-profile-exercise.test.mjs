import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertQa1NativeQualification, readQa1NativeQualification, assertQa1ExerciseAdmission, projectQa1ExerciseAPIResponse,
  QA1_EXERCISE_SELECTIONS, collectQa1ExerciseCatalog, createQa1ExplorerSelectionOwner, gradeQa1ProfileFiles, prepareQa1IndependentFiles, verifyQa1HeldOut, projectQa1CausalRepair, runQa1ProfileExercise, preserveQa1StartupFailure, runQa1AdditionalAgentTasks, QA1_ADDITIONAL_AGENT_CASES } from './qa1-profile-exercise.mjs';
import { createQaProfileProjectFixture, finishQaProfileProjectFixture } from './profile-project-fixture.mjs';
import { DEFAULT_HELPER_MODEL_SELECTION } from '../../packages/shared-runtime/lib/helper-model-selection.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function qualification() {
  const sources = { 'scripts/qa/qa1-profile-exercise.mjs': 'a'.repeat(64), 'packages/cursor-sdk-runtime/session.js': 'b'.repeat(64), 'scripts/agent-evals/cases.mjs': 'a'.repeat(64) };
  const currentSource = { sourceDigest: digest(sources), sources }, runnerSha256 = 'c'.repeat(64);
  const expected = { buildID: 'd'.repeat(64), artifactManifestSha256: 'e'.repeat(64) };
  return { expected, currentSource, runnerSha256, run: { schemaVersion: 1, owner: 'scripts/verify-opencode-v2-package.mjs', status: 'passed' },
    report: { status: 'passed', artifact: { buildId: expected.buildID, manifestSha256: expected.artifactManifestSha256 }, runnerSha256,
      diagnostic: false, preflight: false, managedCorrectness: false, retainedShellDiagnostic: false, source: structuredClone(currentSource),
      sourceCohort: { valid: true, changedPaths: [] }, cleanupFailures: [], remainingMandatoryGates: [], cases: [
        'compiled-production-artifacts', 'compiled-ready-catalog', 'compiled-fresh-native-initialization', 'compiled-v2-derived-bundle-clone',
        'candidate-work-rollback-retention', 'compiled-durable-journal-roots'].map(id => ({ id, status: 'passed' })) } };
}
function admission() {
  const catalog = { connected: ['openai', 'cursor-acp', 'opencode'], catalogIncomplete: false, all: [
    { id: 'openai', models: { 'gpt-6-astra': { variants: { medium: {} } } } },
    { id: 'cursor-acp', models: { 'grok-4.6': { variants: { medium: {} } } } },
    { id: 'opencode', models: { [DEFAULT_HELPER_MODEL_SELECTION.modelID]: { variants: {} } } },
  ] };
  const agents = Object.entries(QA1_EXERCISE_SELECTIONS).map(([name, selected]) => ({ name,
    model: { providerID: selected.providerID, modelID: selected.modelID }, variant: selected.variant }));
  return { admitted: true, ready: true, statuses: {}, catalog, agents, helper: { ...DEFAULT_HELPER_MODEL_SELECTION } };
}

test('full native qualification requires actual owner, full cases, exact artifact, current source and runner pins', () => {
  assert.equal(assertQa1NativeQualification(qualification()).buildID, 'd'.repeat(64));
  const changes = [
    value => value.run.owner = 'foreign', value => value.run.status = 'running', value => value.report.status = 'preflight-passed',
    ...['diagnostic', 'preflight', 'managedCorrectness', 'retainedShellDiagnostic'].map(key => value => value.report[key] = true),
    value => delete value.report.runnerSha256, value => value.report.runnerSha256 = 'f'.repeat(64),
    value => value.report.sourceCohort.changedPaths.push('scripts/qa/qa1-profile-exercise.mjs'),
    value => value.report.cleanupFailures.push({ code: 'failed' }), value => value.report.remainingMandatoryGates.push('full'),
    value => value.report.cases.pop(), value => value.report.cases.push(value.report.cases[0]),
    value => value.report.cases[0].status = 'failed', value => value.report.artifact.manifestSha256 = 'f'.repeat(64),
    value => value.report.artifact.buildId = 'f'.repeat(64),
  ];
  for (const change of changes) { const value = qualification(); change(value); assert.throws(() => assertQa1NativeQualification(value), /qa_profile_native_qualification_required/); }
  for (const file of ['scripts/qa/qa1-profile-exercise.mjs', 'packages/cursor-sdk-runtime/session.js', 'scripts/agent-evals/cases.mjs']) {
    const value = qualification(); value.currentSource.sources[file] = 'f'.repeat(64); value.currentSource.sourceDigest = digest(value.currentSource.sources);
    assert.throws(() => assertQa1NativeQualification(value), /qa_profile_native_qualification_required/);
  }
});

test('missing/manual admission and non-package qualification path produce no API or fixture work', async () => {
  let calls = 0;
  await assert.rejects(runQa1ProfileExercise({ admitted: () => false, api: async () => { calls++; } }), /qa_profile_manual_admission_required/);
  await assert.rejects(runQa1ProfileExercise({ admitted: () => true, api: async () => { calls++; }, qualificationReport: path.resolve('.cache/qa/handoff.json'),
    selectedIdentity: qualification().expected }), /qa_profile_native_qualification_required/);
  assert.equal(calls, 0);
  await assert.rejects(readQa1NativeQualification('/outside/result.json', qualification().expected), /qa_profile_native_qualification_required/);
});

test('owned admission refuses busy/incomplete or wrong saved model and effort without selecting a replacement', () => {
  assert.deepEqual(assertQa1ExerciseAdmission(admission()).selections, QA1_EXERCISE_SELECTIONS);
  const changes = [value => value.admitted = false, value => value.ready = false, value => value.statuses = { ses_busy: { type: 'busy' } },
    value => value.statuses = [], value => value.catalog.catalogIncomplete = true, value => value.catalog.catalogIncomplete = 'private',
    value => value.catalog.connected = ['openai'], value => value.catalog.all[0].models['gpt-6-astra'].variants = {},
    value => value.agents[2].variant = 'high', value => value.agents[2].model.modelID = 'wrong',
    value => value.helper.modelID = 'wrong'];
  for (const change of changes) { const value = admission(); change(value); assert.throws(() => assertQa1ExerciseAdmission(value), /qa_profile_/); }
  const alias = admission(); alias.agents[0].name = 'build'; assertQa1ExerciseAdmission(alias);
  alias.agents[0].model.modelID = 'gpt-6.1-sol'; alias.agents[0].variant = 'high';
  alias.helper.revision = '4f460d83-389a-42a5-93cb-23cd7c5dbd64';
  assert.equal(assertQa1ExerciseAdmission(alias).helper.revision, alias.helper.revision);
  assert.deepEqual(projectQa1ExerciseAPIResponse('/api/config/settings', { helperModelSelection: alias.helper }).helperModelSelection, alias.helper);
});

test('catalog/selection/settings callback projection removes provider credentials, accounts and unknown metadata', () => {
  const value = admission();
  value.catalog.all[0].account = 'private-account'; value.catalog.all[0].models['gpt-6-astra'].variants.medium.secret = 'private-token';
  value.catalog.all[0].models['gpt-6-astra'].variants.high = { secret: 'private-token' };
  value.catalog.all.push({ id: 'private-provider', models: { 'private-model': { credential: 'private-credential' } } });
  const catalog = projectQa1ExerciseAPIResponse('/api/provider?directory=owned', value.catalog);
  assert.doesNotMatch(JSON.stringify(catalog), /private-|secret|credential|account/);
  assert.deepEqual(catalog.all[0].models['gpt-6-astra'].variants.high, {});
  assertQa1ExerciseAdmission({ ...value, catalog });
  value.agents[2].account = 'private-account'; value.agents[2].model.modelID = 'private-account';
  const agents = projectQa1ExerciseAPIResponse('/api/agent', value.agents);
  assert.doesNotMatch(JSON.stringify(agents), /private-|account/);
  assert.throws(() => assertQa1ExerciseAdmission({ ...admission(), agents }), /saved_selection_mismatch/);
  const settings = projectQa1ExerciseAPIResponse('/api/config/settings', { helperModelSelection: DEFAULT_HELPER_MODEL_SELECTION,
    lastDirectory: path.resolve('.cache/qa/owned'), activeProjectId: 'owned', privateAccount: 'private-account', token: 'private-token' });
  assert.doesNotMatch(JSON.stringify(settings), /private-|token|account/);
  assert.deepEqual(projectQa1ExerciseAPIResponse('/api/git/pr-description', { title: 'private title', body: 'private body', credential: 'private token' }), { validResponse: true });
  assert.deepEqual(projectQa1ExerciseAPIResponse('/api/git/commit-message/draft', { status: 'complete', commits: [{ subject: 'private title', details: ['private body'] }] }), { status: 'complete', commits: [{}] });
});

test('helper admission preserves a valid saved fallback revision from the shared settings contract', () => {
  const value = admission();
  value.helper.revision = 'helper_m39_a1';
  const settings = projectQa1ExerciseAPIResponse('/api/config/settings', { helperModelSelection: value.helper });
  assert.deepEqual(settings.helperModelSelection, value.helper);
  assert.deepEqual(assertQa1ExerciseAdmission({ ...value, helper: settings.helperModelSelection }).helper, value.helper);
  for (const revision of ['', 'has space', 'x'.repeat(257)]) {
    assert.throws(() => assertQa1ExerciseAdmission({ ...value, helper: { ...value.helper, revision } }), /helper_selection_mismatch/);
  }
});

function cursorDiscovery() {
  const native = admission().catalog;
  native.connected = ['openai', 'opencode']; native.all = native.all.filter(row => row.id !== 'cursor-acp');
  const feature = { providers: [admission().catalog.all[1]], default: {}, catalogIncomplete: false };
  const verify = { success: true, ok: true, configured: true, modelsSource: 'sdk', modelCount: 46, lastModelRefreshTimedOut: false };
  const runtime = { sdkAuthConfigured: true, authObservation: 'known', modelsSource: 'sdk', modelCount: 46, lastModelRefreshTimedOut: false };
  return { native, feature, verify, runtime, statuses: {} };
}
async function collectDiscovery(value, calls = []) {
  return collectQa1ExerciseCatalog(async (route, options = {}) => {
    calls.push({ route, method: options.method ?? 'GET' });
    const pathname = new URL(route, 'http://qa.invalid').pathname;
    const raw = pathname === '/api/provider' ? value.native : pathname === '/api/config/providers' ? value.feature
      : pathname.endsWith('/configure') ? value.verify : pathname.endsWith('/runtime-status') ? value.runtime : value.statuses;
    return projectQa1ExerciseAPIResponse(route, raw);
  }, '/owned qa/project');
}

test('QA catalogue joins actual SDK Cursor feature metadata with native nonCursor connections', async () => {
  const value = cursorDiscovery(), calls = [];
  value.feature.providers.push({ id: 'openai', models: { 'gpt-6-astra': { variants: {} } }, credential: 'private-token' });
  value.verify.error = 'private-account'; value.runtime.account = 'private-account';
  const catalog = await collectDiscovery(value, calls);
  assertQa1ExerciseAdmission({ ...admission(), catalog });
  assert.deepEqual(catalog.connected, ['openai', 'opencode', 'cursor-acp']);
  assert.deepEqual(catalog.all.find(row => row.id === 'openai'), projectQa1ExerciseAPIResponse('/api/provider', value.native).all[0]);
  assert.doesNotMatch(JSON.stringify(catalog), /private-|credential|account/);
  assert.deepEqual(calls.map(row => row.method), ['GET', 'POST', 'GET', 'GET', 'GET']);
  assert.ok(calls.slice(1).every(row => new URL(row.route, 'http://qa.invalid').searchParams.get('directory') === '/owned qa/project'));
});

test('SDK Verify failure/fallback/unknown auth cannot admit declared Grok metadata or replace native connections', async () => {
  const changes = [v => v.verify.ok = false, v => v.verify.configured = false, v => v.verify.success = false,
    v => v.verify.modelsSource = 'fallback', v => v.verify.modelCount = 0, v => v.verify.lastModelRefreshTimedOut = true,
    v => v.runtime.modelsSource = 'fallback', v => v.runtime.sdkAuthConfigured = false, v => v.runtime.authObservation = 'unknown',
    v => v.runtime.modelCount = 0, v => v.runtime.lastModelRefreshTimedOut = true, v => delete v.runtime.modelsSource,
    v => v.feature.providers[0].models['grok-4.6'].variants = { high: {} }, v => v.feature.providers = [],
    v => v.feature.providers.push(v.feature.providers[0]), v => v.feature.catalogIncomplete = true];
  for (const change of changes) { const value = cursorDiscovery(); change(value); await assert.rejects(collectDiscovery(value), /qa_profile_/); }
  const value = cursorDiscovery(); value.native.connected = ['opencode'];
  const catalog = await collectDiscovery(value);
  assert.throws(() => assertQa1ExerciseAdmission({ ...admission(), catalog }), /saved_selection_mismatch/);
  const busy = cursorDiscovery(), calls = []; busy.statuses = { ses_busy: { type: 'busy' } };
  await assert.rejects(collectDiscovery(busy, calls), /runtime_not_idle/);
  assert.deepEqual(calls.map(row => row.route), ['/api/session/status']);
});

function explorerFixture({ previous = { model: 'cursor-acp/grok-4.6', variant: 'high' }, failAfterPersist = false, failBeforeRevision = false } = {}) {
  let stored = structuredClone(previous), live = structuredClone(previous), revision = 0, appliedRevision = 0;
  const calls = [], primary = { model: { providerID: 'openai', modelID: 'gpt-6.1-sol' }, variant: 'high', name: 'orchestrator' };
  const status = () => ({ revision, appliedRevision, state: revision === appliedRevision ? 'clean' : 'pending', pending: revision !== appliedRevision,
    scopes: revision === appliedRevision ? [] : ['agents'], reasonCodes: revision === appliedRevision ? [] : ['CONFIG_AGENTS_CHANGED'],
    activeSessionCount: 0, runtimeMode: 'managed', canApplyWhenIdle: true, canForceRestart: false });
  const api = async (route, options = {}) => {
    calls.push({ route, ...options });
    const pathname = new URL(route, 'http://qa.invalid').pathname;
    if (pathname === '/api/config/apply-status') return status();
    if (pathname === '/api/config/apply') {
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), { expectedRevision: revision, mode: 'when-idle' });
      live = structuredClone(stored); appliedRevision = revision;
      return { status: status(), appliedRevision, appliedScopes: ['agents'], userConfirmed: false };
    }
    if (pathname === '/api/agent') {
      assert.equal(revision, appliedRevision, 'saved overrides require the explicit apply API before live polling');
      return [{ ...primary }, { name: 'explorer', hidden: false,
        model: { providerID: 'cursor-acp', modelID: 'grok-4.6' }, variant: live?.variant ?? 'high' }];
    }
    if (pathname === '/api/config/agent-overrides') return { explorer: structuredClone(stored) };
    assert.equal(pathname, '/api/config/agents/explorer/override');
    stored = options.method === 'DELETE' ? null : JSON.parse(options.body);
    if (failBeforeRevision && stored?.variant === 'medium') return projectQa1ExerciseAPIResponse(route, { success: true, reloadFailed: true });
    revision++;
    if (failAfterPersist && stored?.variant === 'medium') throw Object.assign(new Error('failed'), { code: 'qa_profile_explorer_recording_failed' });
    return { success: true, runtimeApplied: false, requiresReload: false, requiresApply: true,
      applyRevision: revision, applyScopes: ['agents'], applyStatus: status() };
  };
  return { api, calls, primary, status, get stored() { return stored; }, get live() { return live; }, replace: value => { stored = value; revision++; } };
}

test('temporary exact Grok Medium selector restores captured override and leaves primary defaults untouched', async () => {
  for (const previous of [{ model: 'cursor-acp/grok-4.6', variant: 'high' }, null, { variant: 'high' }]) {
    const fixture = explorerFixture({ previous }), owner = createQa1ExplorerSelectionOwner({ api: fixture.api, directory: '/owned/project' });
    await owner.apply(fixture.api); assert.deepEqual(fixture.stored, { model: 'cursor-acp/grok-4.6', variant: 'medium' });
    await owner.restore(); assert.deepEqual(fixture.stored, previous); assert.deepEqual(fixture.live, previous);
    assert.deepEqual(fixture.calls.filter(row => row.route === '/api/config/apply').map(row => JSON.parse(row.body)),
      [{ expectedRevision: 1, mode: 'when-idle' }, { expectedRevision: 2, mode: 'when-idle' }]);
    assert.equal(fixture.primary.variant, 'high'); assert.equal(fixture.primary.model.modelID, 'gpt-6.1-sol');
    const mutations = fixture.calls.filter(row => ['PUT', 'DELETE'].includes(row.method));
    assert.ok(mutations.every(row => row.route === '/api/config/agents/explorer/override?directory=%2Fowned%2Fproject'));
    assert.equal(mutations[1].method, previous === null ? 'DELETE' : 'PUT');
    assert.ok(mutations[1].signal instanceof AbortSignal); assert.equal(mutations[1].signal.aborted, false);
  }
});

test('persisted apply failure still restores; newer human override is preserved with explicit cleanup refusal', async () => {
  const fixture = explorerFixture({ failAfterPersist: true }), owner = createQa1ExplorerSelectionOwner({ api: fixture.api, directory: '/owned/project' });
  await assert.rejects(owner.apply(fixture.api), { code: 'qa_profile_explorer_recording_failed' }); await owner.restore(); assert.equal(fixture.stored.variant, 'high');
  const human = explorerFixture(), humanOwner = createQa1ExplorerSelectionOwner({ api: human.api, directory: '/owned/project' });
  await humanOwner.apply(human.api); human.replace({ model: 'cursor-acp/grok-4.6', variant: 'low' });
  await assert.rejects(humanOwner.restore(), /restore_changed/); assert.equal(human.stored.variant, 'low');
  const already = explorerFixture({ previous: { model: 'cursor-acp/grok-4.6', variant: 'medium' } });
  const noChange = createQa1ExplorerSelectionOwner({ api: already.api, directory: '/owned/project' });
  await noChange.apply(already.api); await noChange.restore(); assert.equal(already.calls.length, 1);
});

test('Explorer override projection preserves exact restoration shape and rejects fields it cannot restore', () => {
  assert.deepEqual(projectQa1ExerciseAPIResponse('/api/config/agent-overrides', { overrides: { privateAgent: { token: 'private-token' } } }), { explorer: null });
  assert.deepEqual(projectQa1ExerciseAPIResponse('/api/config/agent-overrides', { overrides: { explorer: { variant: 'high' } } }), { explorer: { variant: 'high' } });
  for (const explorer of [{ model: 'private-provider/private-model' }, { variant: 'private-account' }, { model: 'cursor-acp/grok-4.6', councillors: [] }, {}])
    assert.throws(() => projectQa1ExerciseAPIResponse('/api/config/agent-overrides', { overrides: { explorer } }), /restore_unavailable/);
  assert.throws(() => projectQa1ExerciseAPIResponse('/api/config/agents/explorer/override', { success: true, reloadFailed: true, warning: 'private error' }), /recording_failed/);
});

async function withFixture(t) {
  const fixture = await createQaProfileProjectFixture({ runId: 'exercise-contract' });
  t.after(async () => { await finishQaProfileProjectFixture(fixture); await fs.rm(fixture.evidenceDirectory, { recursive: true, force: true }); });
  return fixture;
}

test('Plan preserves dirty user fixture and refuses implementation or original-test changes', async t => {
  const fixture = await withFixture(t);
  assert.equal((await gradeQa1ProfileFiles(fixture, { planned: true })).originalTrackedPreserved, true);
  await fs.appendFile(path.join(fixture.fixtureRoot, 'docs/user-notes.md'), 'wrong');
  await assert.rejects(gradeQa1ProfileFiles(fixture, { planned: true }), /qa_profile_protected_fixture_changed/);
});

test('three heldouts and unchanged seeded suite execute without filesystem writes, network or children', async t => {
  const fixture = await withFixture(t), independent = await prepareQa1IndependentFiles(fixture);
  assert.equal(independent.baselineFailed, true);
  const source = path.join(fixture.fixtureRoot, 'src/profile-appearance.mjs');
  const bytes = (await fs.readFile(source, 'utf8')).replace('16 + 64 + Math.max(0, layoutViewportHeight - visualViewportHeight)', '16 + (signedIn ? 64 : 0)')
    .replace("dark ? '#ffffff' : '#e8edf3'", "dark ? '#222b38' : '#e8edf3'")
    .replaceAll("'#19395c'", "'#131a24'").replaceAll("'#315981'", "'#344055'")
    .replace("dark && scrolled ? '#101723' : 'transparent'", "'transparent'");
  await fs.writeFile(source, bytes);
  assert.equal((await verifyQa1HeldOut(fixture, independent.run)).passed.length, 3);
  assert.equal((await gradeQa1ProfileFiles(fixture)).originalTrackedPreserved, true);
  const outside = path.join(fixture.evidenceDirectory, 'ungranted-sentinel.txt'); await fs.writeFile(outside, 'fixture sentinel');
  for (const expression of [`import fs from 'node:fs';fs.readFileSync(${JSON.stringify(outside)});`,
    `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(source)},'wrong');`,
    `import net from 'node:net';net.createConnection({host:'127.0.0.1',port:54321});`, `import{spawnSync}from'node:child_process';spawnSync(process.execPath,['-e','']);`]) {
    await assert.rejects(independent.run(['--input-type=module', '-e', expression]), error => error.code === 1 && /ERR_ACCESS_DENIED/.test(error.stderr));
  }
  assert.equal(await fs.readFile(source, 'utf8'), bytes);
});

test('causal repair requires real timed native exits, preserves raw command/output exclusion and rejects reordered work', () => {
  const directory = path.resolve('.cache/qa/project');
  const tool = (callID, name, input, start, end, exit) => ({ type: 'tool', tool: name, callID,
    state: { status: 'completed', input, output: 'private raw output', time: { start, end }, ...(exit === undefined ? {} : { metadata: { exit } }) } });
  const parts = [tool('read', 'read', { path: 'src/profile-appearance.mjs' }, 1, 2),
    tool('fail', 'shell', { command: 'node --test test/profile.test.mjs' }, 3, 4, 1),
    tool('write', 'edit', { path: 'src/profile-appearance.mjs' }, 5, 6),
    tool('pass', 'shell', { command: 'node --test test/profile.test.mjs' }, 7, 8, 0),
    tool('suite', 'shell', { command: 'npm test' }, 9, 10, 0)];
  const sessions = [{ sessionID: 'ses_fixture', messages: [{ parts }] }];
  const result = projectQa1CausalRepair(sessions, directory); assert.equal(result.passed, true);
  assert.doesNotMatch(JSON.stringify(result), /private raw|command|output|publishedRepair/);
  for (const change of [next => delete next[1].state.metadata, next => next[1].state.input.command += ' || true',
    next => next[2].state.time.start = 3, next => next[4].state.metadata.exit = 1]) {
    const next = structuredClone(parts); change(next); assert.equal(projectQa1CausalRepair([{ sessionID: 'ses_fixture', messages: [{ parts: next }] }], directory).passed, false);
  }
});


test('browser startup preserves its first failure and records independent cleanup failure', async () => {
  const original = new Error('primary');
  await assert.rejects(preserveQa1StartupFailure(original, async () => {}), error => error === original);
  await assert.rejects(preserveQa1StartupFailure(original, async () => { throw new Error('cleanup'); }), error =>
    error.cause === original && error.qaCleanupFailed === true && error.errors.length === 2);
});

test('additional task dispatch reuses three exact eval cases and confined tests with owned API cleanup signals', async t => {
  const fixture = await withFixture(t), controller = new AbortController();
  const observed = []; let checks = 0, active;
  const results = await runQa1AdditionalAgentTasks({ root: fixture.evidenceDirectory, origin: 'http://127.0.0.1:54321', signal: controller.signal,
    deadline: performance.now() + 60000, beforeRequest: async () => { checks++; }, activate: async value => { active = value; }, api: async () => ({}),
    caseExecutor: async options => {
      observed.push(options.caseId);
      assert.equal(options.fixtureRoot, active); assert.equal(options.selection.modelId, 'gpt-6-astra'); assert.equal(options.selection.variant, 'medium');
      assert.equal(options.selection.agent, options.caseId === 'managed-independent' ? 'orchestrator' : 'builder');
      assert.equal((await options.testRunner({ fixtureRoot: active, timeoutMs: 10000 })).exitCode, 0);
      assert.ok(options.runFiles.ownedPaths.every(file => file.startsWith(active + path.sep)));
      return { caseId: options.caseId, status: 'passed', durationMs: 1, graders: [{ id: options.caseId + '.fixture', passed: true }],
        sessionIds: ['ses_owned'], cleanup: { restored: true, sessionComplete: true, sessionDiscoveryComplete: true, sessionAbortFailureCount: 0 } };
    } });
  assert.deepEqual(observed, QA1_ADDITIONAL_AGENT_CASES); assert.equal(results.length, 3); assert.equal(checks, 3);
  assert.doesNotMatch(JSON.stringify(results), /prompt|output|credential|account/);
});

test('Explorer refuses preexisting global batches, external runtimes and concurrent revisions before applying', async () => {
  for (const alter of [s => ({ ...s, revision: 1, pending: true, state: 'pending', scopes: ['providers'], reasonCodes: ['CONFIG_PROVIDERS_CHANGED'] }),
    s => ({ ...s, runtimeMode: 'external', canApplyWhenIdle: false })]) {
    const fixture = explorerFixture();
    const api = async (route, options) => { const value = await fixture.api(route, options); return route === '/api/config/apply-status' ? alter(value) : value; };
    await assert.rejects(createQa1ExplorerSelectionOwner({ api, directory: '/owned/project' }).apply(api), /apply_baseline_not_clean/);
    assert.equal(fixture.calls.some(row => row.method), false);
  }
  const fixture = explorerFixture();
  const api = async (route, options) => {
    const value = await fixture.api(route, options);
    if (options?.method === 'PUT') fixture.replace({ model: 'cursor-acp/grok-4.6', variant: 'low' });
    return value;
  };
  const owner = createQa1ExplorerSelectionOwner({ api, directory: '/owned/project' });
  await assert.rejects(owner.apply(api), /recording_failed/);
  await assert.rejects(owner.restore(), /restore_changed/);
  assert.equal(fixture.calls.some(row => row.route === '/api/config/apply'), false);
  assert.equal(fixture.stored.variant, 'low');
});

test('Explorer apply refusal does not poll live state; its separately captured restoration applies safely', async () => {
  const fixture = explorerFixture(); let refuse = true;
  const api = async (route, options) => {
    if (route === '/api/config/apply' && refuse) { refuse = false; throw Object.assign(Error('private backend body'), { code: 'qa_profile_explorer_apply_failed' }); }
    return fixture.api(route, options);
  };
  const owner = createQa1ExplorerSelectionOwner({ api, directory: '/owned/project' });
  await assert.rejects(owner.apply(api), { code: 'qa_profile_explorer_apply_failed' });
  assert.equal(fixture.stored.variant, 'medium'); assert.equal(fixture.live.variant, 'high');
  await owner.restore(); assert.equal(fixture.stored.variant, 'high'); assert.equal(fixture.live.variant, 'high');
  assert.deepEqual(fixture.calls.filter(row => row.route === '/api/config/apply').map(row => JSON.parse(row.body)), [{ expectedRevision: 2, mode: 'when-idle' }]);
});

test('Explorer refuses a stale apply revision and reports failed restoration without force or accepting saved-only success', async () => {
  const stale = explorerFixture();
  const api = async (route, options) => {
    if (route === '/api/config/apply') { stale.replace({ model: 'cursor-acp/grok-4.6', variant: 'low' }); throw Object.assign(Error('conflict'), { code: 'qa_profile_explorer_apply_revision_conflict' }); }
    return stale.api(route, options);
  };
  const owner = createQa1ExplorerSelectionOwner({ api, directory: '/owned/project' });
  await assert.rejects(owner.apply(api), { code: 'qa_profile_explorer_apply_revision_conflict' }); await assert.rejects(owner.restore(), /restore_changed/);
  const fixture = explorerFixture(); let restoring = false;
  const cleanupApi = async (route, options) => {
    if (restoring && route === '/api/config/apply') throw Error('private restoration failure');
    return fixture.api(route, options);
  };
  const cleanup = createQa1ExplorerSelectionOwner({ api: cleanupApi, directory: '/owned/project' });
  await cleanup.apply(cleanupApi); restoring = true;
  await assert.rejects(cleanup.restore(), { code: 'qa_profile_explorer_apply_failed' });
  assert.equal(fixture.stored.variant, 'high'); assert.equal(fixture.live.variant, 'medium');
  await assert.rejects(cleanup.restore(), /restore_convergence_failed/);
  assert.ok(fixture.calls.filter(row => row.route === '/api/config/apply').every(row => JSON.parse(row.body).mode === 'when-idle'));
});

test('Explorer projection retains finite revision contracts and excludes warnings, bodies and unrelated metadata', () => {
  const fixture = explorerFixture(), status = fixture.status();
  assert.deepEqual(projectQa1ExerciseAPIResponse('/api/config/apply-status', { ...status, secret: 'private', lastError: { message: 'private' } }), status);
  for (const alter of [s => ({ ...s, revision: -1 }), s => ({ ...s, scopes: ['private'] }), s => ({ ...s, reasonCodes: ['private'] }),
    s => ({ ...s, activeSessionCount: NaN }), s => ({ ...s, appliedRevision: 2 }), s => ({ ...s, pending: 'private' })])
    assert.throws(() => projectQa1ExerciseAPIResponse('/api/config/apply-status', alter(status)), /response_invalid/);
  assert.throws(() => projectQa1ExerciseAPIResponse('/api/config/agents/explorer/override', { success: true }), /response_invalid/);
  assert.throws(() => projectQa1ExerciseAPIResponse('/api/config/apply', { status, appliedRevision: 0, appliedScopes: ['providers'], userConfirmed: false }), /response_invalid/);
});

test('Explorer waits for exact clean apply before live reads and preserves cancellation instead of retrying or forcing', async () => {
  const fixture = explorerFixture(); let waiting = false, statusReads = 0;
  const api = async (route, options) => {
    if (route === '/api/config/apply' && !waiting) {
      waiting = true;
      return { status: { ...fixture.status(), state: 'waiting_for_idle', activeSessionCount: 1 }, appliedRevision: 0, appliedScopes: [], userConfirmed: false };
    }
    if (route === '/api/config/apply-status' && waiting && ++statusReads === 1) {
      await fixture.api('/api/config/apply', { method: 'POST', body: JSON.stringify({ expectedRevision: 1, mode: 'when-idle' }) });
    }
    return fixture.api(route, options);
  };
  const owner = createQa1ExplorerSelectionOwner({ api, directory: '/owned/project' });
  await owner.apply(api); assert.equal(fixture.live.variant, 'medium'); await owner.restore();
  const cancelled = explorerFixture(), abort = new DOMException('cancelled', 'AbortError');
  const request = (route, options) => route === '/api/config/apply' ? Promise.reject(abort) : cancelled.api(route, options);
  const cancelOwner = createQa1ExplorerSelectionOwner({ api: cancelled.api, directory: '/owned/project' });
  await assert.rejects(cancelOwner.apply(request), error => error === abort);
  await cancelOwner.restore(); assert.equal(cancelled.live.variant, 'high');
});

test('Explorer restores persisted overrides when coordinator recording failed before incrementing a revision', async () => {
  const fixture = explorerFixture({ failBeforeRevision: true });
  const owner = createQa1ExplorerSelectionOwner({ api: fixture.api, directory: '/owned/project' });
  await assert.rejects(owner.apply(fixture.api), { code: 'qa_profile_explorer_recording_failed' });
  assert.equal(fixture.status().revision, 0); assert.equal(fixture.stored.variant, 'medium'); assert.equal(fixture.live.variant, 'high');
  await owner.restore(); assert.equal(fixture.live.variant, 'high'); assert.equal(fixture.stored.variant, 'high');
  assert.deepEqual(fixture.calls.filter(row => row.route === '/api/config/apply').map(row => JSON.parse(row.body)), [{ expectedRevision: 1, mode: 'when-idle' }]);
});

test('Explorer asynchronous apply failure remains distinct from concurrency and can restore its own failed batch', async () => {
  const fixture = explorerFixture(); let failed = false;
  const api = async (route, options) => {
    if (route === '/api/config/apply' && !failed) {
      failed = true;
      return { status: { ...fixture.status(), state: 'waiting_for_idle' }, appliedRevision: 0, appliedScopes: [], userConfirmed: false };
    }
    const result = await fixture.api(route, options);
    return route === '/api/config/apply-status' && failed && result.revision === 1 ? { ...result, state: 'failed' } : result;
  };
  const owner = createQa1ExplorerSelectionOwner({ api, directory: '/owned/project' });
  await assert.rejects(owner.apply(api), { code: 'qa_profile_explorer_apply_failed' });
  await owner.restore(); assert.equal(fixture.live.variant, 'high'); assert.equal(fixture.status().appliedRevision, 2);
});

test('Explorer aborted server-side apply and idle watcher cannot overlap restoration or a newer apply', async () => {
  for (const state of ['applying', 'waiting_for_idle']) {
    const fixture = explorerFixture(); let submitted = false;
    const api = async (route, options) => {
      if (route === '/api/config/apply') { submitted = true; throw new DOMException('cancelled', 'AbortError'); }
      const result = await fixture.api(route, options);
      return submitted && route === '/api/config/apply-status' ? { ...result, state } : result;
    };
    const owner = createQa1ExplorerSelectionOwner({ api, directory: '/owned/project' });
    await assert.rejects(owner.apply(api), { name: 'AbortError' });
    await assert.rejects(owner.restore(), { code: 'qa_profile_explorer_restore_apply_in_progress' });
    assert.equal(fixture.calls.filter(row => ['PUT', 'DELETE'].includes(row.method)).length, 1);
    assert.equal(fixture.stored.variant, 'medium'); assert.equal(fixture.live.variant, 'high');
  }
  const fixture = explorerFixture(); let restoring = false;
  const api = async (route, options) => {
    const result = await fixture.api(route, options);
    return restoring && options?.method === 'PUT' ? { ...result, applyStatus: { ...result.applyStatus, state: 'applying' } } : result;
  };
  const owner = createQa1ExplorerSelectionOwner({ api, directory: '/owned/project' });
  await owner.apply(api); restoring = true;
  await assert.rejects(owner.restore(), { code: 'qa_profile_explorer_recording_apply_in_progress' });
  assert.equal(fixture.calls.filter(row => row.route === '/api/config/apply').length, 1);
});
