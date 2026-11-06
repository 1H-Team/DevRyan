import assert from 'node:assert/strict';
import test from 'node:test';
import { TRIAL_ARMS, TRIAL_GRAPH, pinTrialSetupFile, trialGraphMismatches, trialAgentOverrides, armLaunchEnvironment, compareArmFingerprints, foreignGraphRoutes, helperSelection, parseTrialArgs,
  savedGraphRoutes, selectionFromGraph, restartTrialHosts } from './adaptive-delegation-trials.mjs';

const h = character => character.repeat(64);
const graph = () => ({
  agentSelections: {
    orchestrator: { model: 'openai/gpt-6.1-sol', variant: 'high', promptSha256: h('a') },
    explorer: { model: 'openai/gpt-6.1-mini', variant: null, promptSha256: h('b') },
  },
  nativeBackupSelections: { slim: { runtimeChains: { orchestrator: ['openai/gpt-6.1-sol'] }, modelArrays: { orchestrator: [{ id: 'openai/gpt-6.1-sol', variant: 'medium' }] },
    fallback: {}, effectiveExecutionVariant: 'default' }, devryan: {} },
  nativeCompactionSettings: {},
  councilMembers: [{ providerId: 'openai', modelId: 'gpt-6.1-sol', variant: 'high', agent: 'orchestrator', timeoutMs: 180000 }],
});
const fingerprint = (adaptiveDelegation, overrides = {}) => ({
  schemaVersion: 1, runtimeVersion: '2.2.5', runtimeHash: h('1'),
  selection: { providerID: 'openai', modelID: 'gpt-6.1-sol', agent: 'orchestrator', variant: 'high' },
  role: { contentHash: h(adaptiveDelegation ? '3' : '2'), attestedContentHash: h(adaptiveDelegation ? '3' : '2'), templateHash: h('4'), rendererHash: h('5') },
  catalog: { contentHash: h('6'), idsHash: h('7'), count: 1, availability: 'available', tools: [{ id: 'read', contentHash: h('8') }] },
  plugins: { configured: [{ name: 'devryan-managed.js' }], observed: null },
  policies: { readOverlap: true, waitAny: true, compactResults: true, contextProjection: false, duplicateOutputs: false, adaptiveDelegation },
  policySource: 'runtime-projection',
  switches: { DEVRYAN_LAZY_BASE_RUNS: 'unset', DEVRYAN_NATIVE_ARCHIVE: 'unset' },
  ...overrides,
});

test('arguments require an artifact root and admit only an OpenAI helper', () => {
  assert.deepEqual(parseTrialArgs(['--artifact-root', '/repo/.cache/a', '--dry-run']),
    { artifactRoot: '/repo/.cache/a', agent: 'orchestrator', helperModel: null, dryRun: true, keepArtifacts: false });
  assert.throws(() => parseTrialArgs([]), { code: 'qa_trials_flags_invalid' });
  assert.throws(() => parseTrialArgs(['--artifact-root']), { code: 'qa_trials_flags_invalid' });
  assert.throws(() => parseTrialArgs(['--artifact-root', '/a', '--unknown', 'x']), { code: 'qa_trials_flags_invalid' });
  assert.throws(() => parseTrialArgs(['--artifact-root', '/a', '--helper-model', 'opencode/deepseek-v4.1-flash']), { code: 'qa_trials_helper_not_openai' });
  assert.equal(parseTrialArgs(['--artifact-root', '/a', '--helper-model', 'openai/gpt-6.1-mini']).helperModel, 'openai/gpt-6.1-mini');
});

test('a host restart stops every arm before any starts, clears its stale readiness and reports the new origins', async () => {
  const events = [], hosts = new Map(TRIAL_ARMS.map(arm => [arm.id, { stop: async () => { events.push(`stop:${arm.id}`); } }]));
  const origins = await restartTrialHosts({ arms: TRIAL_ARMS, hosts,
    removeReady: async arm => { events.push(`ready-removed:${arm.id}`); },
    startHost: arm => { events.push(`start:${arm.id}`); hosts.set(arm.id, { id: `restarted-${arm.id}` }); },
    waitReady: async (arm, host) => { events.push(`ready:${host.id}`); return { origin: `http://127.0.0.1:${arm.id === 'baseline' ? 1001 : 1002}` }; } });
  assert.deepEqual(events, ['stop:baseline', 'stop:candidate', 'ready-removed:baseline', 'start:baseline', 'ready-removed:candidate', 'start:candidate',
    'ready:restarted-baseline', 'ready:restarted-candidate']);
  assert.deepEqual(origins, { origins: { baseline: 'http://127.0.0.1:1001', candidate: 'http://127.0.0.1:1002' }, unverifiedCleanup: [] });
});

test('a restart continues past an unverifiable stop audit only when the host and every recorded process ended', async () => {
  const unverifiable = Object.assign(new Error('QA owned-process observation is incomplete; cleanup cannot be reported as complete'));
  const host = ({ remaining = [], exited = true, observeFails = false } = {}) => ({
    stop: async () => { throw unverifiable; },
    observe: async () => { if (observeFails) throw new Error('snapshot failed'); return remaining; },
    getCleanupEvidence: () => ({ exitCode: exited ? 0 : null, exitSignal: null }),
  });
  const run = async baseline => {
    const started = [];
    const hosts = new Map([['baseline', baseline], ['candidate', { stop: async () => ({}) }]]);
    const result = await restartTrialHosts({ arms: TRIAL_ARMS, hosts, removeReady: async () => {},
      startHost: arm => { started.push(arm.id); hosts.set(arm.id, { id: arm.id }); },
      waitReady: async arm => ({ origin: `http://127.0.0.1:${arm.id === 'baseline' ? 1001 : 1002}` }) }).catch(error => error);
    return { result, started };
  };
  const clean = await run(host());
  assert.deepEqual(clean.result.unverifiedCleanup, ['baseline']);
  assert.deepEqual(clean.started, ['baseline', 'candidate']);
  for (const refused of [host({ remaining: [{ pid: 42 }] }), host({ exited: false }), host({ observeFails: true })]) {
    const { result, started } = await run(refused);
    assert.equal(result.code, 'qa_trials_restart_stop_incomplete'); assert.deepEqual(result.details, { arm: 'baseline' });
    assert.deepEqual(started, []);
  }
});

test('arms differ only in the adaptive delegation switch', () => {
  assert.deepEqual(TRIAL_ARMS.map(arm => [arm.id, arm.adaptiveDelegation]), [['baseline', '0'], ['candidate', '1']]);
  const native = { HOME: '/q/home', DEVRYAN_ADAPTIVE_DELEGATION: '1', DEVRYAN_ADAPTIVE_OTHER: 'x' };
  const [baseline, candidate] = TRIAL_ARMS.map(arm => armLaunchEnvironment(native, arm, { distDirectory: '/q/dist', gitCeiling: '/q/arm' }));
  assert.equal(baseline.DEVRYAN_ADAPTIVE_DELEGATION, '0'); assert.equal(candidate.DEVRYAN_ADAPTIVE_DELEGATION, '1');
  assert.equal(baseline.DEVRYAN_ADAPTIVE_OTHER, undefined);
  assert.deepEqual({ ...baseline, DEVRYAN_ADAPTIVE_DELEGATION: null }, { ...candidate, DEVRYAN_ADAPTIVE_DELEGATION: null });
  assert.equal(baseline.DEVRYAN_PORT, '0'); assert.equal(baseline.DEVRYAN_DIST_DIR, '/q/dist');
  assert.throws(() => armLaunchEnvironment(native, { id: 'baseline', adaptiveDelegation: '1' }, { distDirectory: '/d', gitCeiling: '/g' }), { code: 'qa_trials_arm_invalid' });
});

test('saved graph routes report every non-OpenAI role, Council and backup route', () => {
  assert.deepEqual(foreignGraphRoutes(graph()), []);
  assert.equal(savedGraphRoutes(graph()).length, 4);
  const mixed = graph();
  mixed.agentSelections.designer = { model: 'xai/grok-4.7', variant: 'medium', promptSha256: h('c') };
  mixed.councilMembers.push({ providerId: 'cursor-acp', modelId: 'grok-4.6', variant: 'medium', agent: 'orchestrator', timeoutMs: 180000 });
  mixed.nativeBackupSelections.devryan.explorer = { model: 'opencode/deepseek-v4.1-flash', variant: null };
  assert.deepEqual(foreignGraphRoutes(mixed).map(route => [route.kind, route.role, route.model]),
    [['role', 'designer', 'xai/grok-4.7'], ['council', 'orchestrator', 'cursor-acp/grok-4.6'], ['backup', 'explorer', 'opencode/deepseek-v4.1-flash']]);
});

test('eval selection and helper come from the saved route, never a chosen model', () => {
  assert.deepEqual(selectionFromGraph(graph(), 'orchestrator'), { providerId: 'openai', modelId: 'gpt-6.1-sol', agent: 'orchestrator', variant: 'high' });
  assert.equal(selectionFromGraph(graph(), 'explorer').variant, null);
  assert.throws(() => selectionFromGraph(graph(), 'fixer'), { code: 'qa_trials_agent_unconfigured' });
  const selection = selectionFromGraph(graph(), 'orchestrator');
  assert.deepEqual(helperSelection(selection, null), { providerID: 'openai', modelID: 'gpt-6.1-sol', revision: 'qa-adaptive-trials' });
  assert.equal(helperSelection(selection, 'openai/gpt-6.1-mini').modelID, 'gpt-6.1-mini');
  assert.throws(() => helperSelection({ ...selection, providerId: 'xai' }, null), { code: 'qa_trials_helper_not_openai' });
});

test('fingerprints match when only the adaptive delegation policy and its attested render differ', () => {
  const result = compareArmFingerprints({ baseline: fingerprint(false), candidate: fingerprint(true) });
  assert.equal(result.matched, true, JSON.stringify(result));
  assert.deepEqual(result.policies, { baseline: false, candidate: true });
  assert.equal(result.observedPlugins, 'pending-first-run');
  const observed = { observed: [{ name: 'devryan-managed.js', contentHash: h('9'), factoryCalls: 1 }], configured: [{ name: 'devryan-managed.js' }] };
  assert.equal(compareArmFingerprints({ baseline: fingerprint(false, { plugins: observed }), candidate: fingerprint(true, { plugins: observed }) }).observedPlugins, 'compared');
});

test('a pre-sign-in catalog is compared only while both arms lack it', () => {
  const unsigned = adaptive => fingerprint(adaptive, { catalog: { contentHash: null, idsHash: null, count: null, availability: 'unavailable', tools: null } });
  const result = compareArmFingerprints({ baseline: unsigned(false), candidate: unsigned(true) });
  assert.equal(result.matched, true, JSON.stringify(result)); assert.equal(result.catalog, 'pending-sign-in');
  assert.equal(compareArmFingerprints({ baseline: fingerprint(false), candidate: fingerprint(true) }).catalog, 'compared');
  assert.ok(compareArmFingerprints({ baseline: unsigned(false), candidate: fingerprint(true) }).reasons.includes('fingerprint_unavailable'));
  const catalogChanged = fingerprint(true, { catalog: { ...fingerprint(true).catalog, contentHash: h('f') } });
  assert.ok(compareArmFingerprints({ baseline: fingerprint(false), candidate: catalogChanged }).reasons.includes('configuration_mismatch'));
});

test('any other difference, a missing policy change or an unattested render refuses the arms', () => {
  const other = fingerprint(true); other.policies = { ...other.policies, contextProjection: true };
  assert.deepEqual(compareArmFingerprints({ baseline: fingerprint(false), candidate: other }).reasons, ['configuration_mismatch']);
  assert.ok(compareArmFingerprints({ baseline: fingerprint(false), candidate: fingerprint(true, { runtimeHash: h('d') }) }).reasons.includes('configuration_mismatch'));
  assert.ok(compareArmFingerprints({ baseline: fingerprint(false), candidate: fingerprint(true, { switches: { DEVRYAN_LAZY_BASE_RUNS: '1', DEVRYAN_NATIVE_ARCHIVE: 'unset' } }) })
    .reasons.includes('configuration_mismatch'));
  const unchanged = compareArmFingerprints({ baseline: fingerprint(true), candidate: fingerprint(true) });
  assert.equal(unchanged.matched, false); assert.ok(unchanged.reasons.includes('experimental_factor_unchanged'));
  assert.ok(unchanged.reasons.includes('arm_policy_unexpected'));
  const tampered = fingerprint(true); tampered.role = { ...tampered.role, contentHash: h('e') };
  assert.ok(compareArmFingerprints({ baseline: fingerprint(false), candidate: tampered }).reasons.includes('role_attestation_mismatch'));
  assert.ok(compareArmFingerprints({ baseline: fingerprint(false, { policySource: 'environment' }), candidate: fingerprint(true) }).reasons.includes('policy_source_unattested'));
  assert.ok(compareArmFingerprints({ baseline: fingerprint(false, { runtimeHash: null }), candidate: fingerprint(true) }).reasons.includes('fingerprint_unavailable'));
});

test('trial pinning rewrites only model routes in every configuration layer', () => {
  const slim = { preset: 'openai', disabled_mcps: ['x'], presets: { go: { orchestrator: { model: 'opencode-go/glm-5.1' }, fixer: { model: 'opencode-go/a', variant: 'high' } } },
    agents: { orchestrator: { model: 'openai/gpt-5.5', variant: 'low' }, builder: { model: 'xai/grok-4.6', variant: 'high', temperature: 0.1 },
      council: { model: 'openai/gpt-5.6-sol', councillors: [{ model: 'opencode/claude-opus-4-5' }, { model: 'opencode/deepseek-v4-flash' }] },
      explorer: { model: 'opencode-go/x', models: ['opencode-go/x', { id: 'xai/y', variant: 'high' }] } } };
  const { bytes, pinned } = pinTrialSetupFile('opencode/oh-my-opencode-slim.json', Buffer.from(JSON.stringify(slim)));
  const value = JSON.parse(bytes); assert.equal(pinned, true);
  assert.deepEqual(value.agents.orchestrator, TRIAL_GRAPH.orchestrator);
  assert.deepEqual(value.agents.builder, { ...TRIAL_GRAPH.subagents, temperature: 0.1 });
  assert.deepEqual(value.agents.council.councillors, [TRIAL_GRAPH.subagents, TRIAL_GRAPH.subagents]);
  assert.deepEqual(value.agents.explorer.models, ['openai/gpt-6.1-sol', { id: 'openai/gpt-6.1-sol', variant: 'medium' }]);
  assert.deepEqual(value.presets.go.orchestrator, TRIAL_GRAPH.orchestrator);
  assert.equal(value.preset, 'openai'); assert.deepEqual(value.disabled_mcps, ['x']);
  const legacy = JSON.parse(pinTrialSetupFile('opencode/opencode.json', Buffer.from(JSON.stringify({ model: 'xai/a', small_model: 'opencode/b', agent: { designer: { model: 'claude-agent/c', prompt: 'p' } }, mcp: {} }))).bytes);
  assert.deepEqual(legacy, { model: 'openai/gpt-6-astra', small_model: 'openai/gpt-6-astra', agent: { designer: { model: 'openai/gpt-6.1-sol', variant: 'medium', prompt: 'p' } }, mcp: {} });
  const markdown = pinTrialSetupFile('opencode/agents/orchestrator.md', Buffer.from('---\nmode: primary\nmodel: openai/gpt-5.5\nvariant: low\npermission:\n  model: keep\n---\nBody model: text\n'));
  assert.equal(markdown.bytes.toString(), '---\nmode: primary\nmodel: openai/gpt-6-astra\nvariant: medium\npermission:\n  model: keep\n---\nBody model: text\n');
  const companion = JSON.parse(pinTrialSetupFile('opencode/agents/council.models.json', Buffer.from('{"version":1,"councillors":[{"model":"xai/a"}]}')).bytes);
  assert.deepEqual(companion, { version: 1, councillors: [TRIAL_GRAPH.subagents] });
  const skill = Buffer.from('{"model":"xai/a"}');
  assert.equal(pinTrialSetupFile('home/.agents/skills/a/config.json', skill).bytes, skill);
});

test('the resolved graph must equal the trial graph exactly', () => {
  const pinned = graph();
  pinned.agentSelections.orchestrator = { ...TRIAL_GRAPH.orchestrator, promptSha256: h('a') };
  pinned.agentSelections.explorer = { ...TRIAL_GRAPH.subagents, promptSha256: h('b') };
  pinned.nativeBackupSelections.slim.modelArrays.orchestrator = [{ id: 'openai/gpt-6-astra', variant: 'medium' }];
  pinned.nativeBackupSelections.slim.runtimeChains.orchestrator = ['openai/gpt-6-astra'];
  pinned.councilMembers = [{ providerId: 'openai', modelId: 'gpt-6.1-sol', variant: 'medium', agent: 'orchestrator', timeoutMs: 180000 }];
  assert.deepEqual(trialGraphMismatches(pinned), []);
  pinned.agentSelections.explorer.variant = 'high';
  pinned.councilMembers[0].modelId = 'gpt-6-astra';
  assert.deepEqual(trialGraphMismatches(pinned).map(route => [route.kind, route.role]), [['role', 'explorer'], ['council', 'orchestrator']]);
});

test('the sidecar override layer pins every routed packaged role and its Council members', () => {
  const { agentOverrides, other } = trialAgentOverrides({ other: 1, agentOverrides: { custom: { model: 'xai/a' } } });
  assert.equal(other, 1);
  assert.deepEqual(agentOverrides.custom, TRIAL_GRAPH.subagents);
  assert.deepEqual(agentOverrides.orchestrator, TRIAL_GRAPH.orchestrator);
  assert.equal(agentOverrides.plan, undefined); assert.equal(agentOverrides.build, undefined);
  for (const role of ['builder', 'designer', 'explorer', 'fixer', 'librarian', 'oracle']) assert.deepEqual(agentOverrides[role], TRIAL_GRAPH.subagents);
  assert.ok(agentOverrides.council.councillors.length > 0);
  assert.ok(agentOverrides.council.councillors.every(row => row.model === TRIAL_GRAPH.subagents.model && row.variant === 'medium'));
});
