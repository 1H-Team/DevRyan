import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { findQaSeededInvestigationStarts, createQaNaturalWorkload, createQaNaturalInvestigationPrompt, QA_NATURAL_COMPACTION_PHASES, deriveQaNativeCompactionPolicy, deriveQaNaturalPrefillTarget, findNaturalCompactionBoundaries, projectQaEarlyNaturalBoundary,
  qaNativeTokenUsage, qaVisibleUserText, runQaNaturalCompaction } from './natural-compaction-scenarios.mjs';
import { readQaSavedPlanRevision } from './compaction-approval.mjs';
import { createQaProjectFixture, removeQaProjectFixture } from './project-fixture.mjs';
import { resolveQaTargetOpenCodeVersion, TARGET_OPENCODE_VERSION } from '../../packages/web/server/lib/opencode/version-policy.js';

const hostPin = { version: TARGET_OPENCODE_VERSION, source: 'host-pin' };
const nativePolicy = overrides => deriveQaNativeCompactionPolicy({ version: TARGET_OPENCODE_VERSION, target: hostPin,
  modelLimits: { context: 1050000, input: 276000, output: 128000 }, ...overrides });
const rows = () => [
  { info: { id: 'msg_usage', role: 'assistant', time: { created: 50, completed: 90 },
    tokens: { input: 250000, output: 2000, cache: { read: 4000, write: 0 } } }, parts: [{ type: 'text', text: 'Audit assessed.' }] },
  { info: { id: 'msg_auto', role: 'user', time: { created: 100 } }, parts: [{ id: 'prt_auto', type: 'compaction', auto: true }] },
  { info: { id: 'msg_summary', role: 'assistant', parentID: 'msg_auto', summary: true, time: { created: 101, completed: 200 } },
    parts: [{ type: 'text', text: 'Revision 2 is current. Implementation remains paused.' }] },
];
const options = () => ({ threshold: 256000, sessionID: 'ses_root', startedAt: 95, observations: [
  { kind: 'native.compacting', sessionID: 'ses_root', at: 102 },
  { kind: 'native.session.compacted', sessionID: 'ses_root', at: 205 },
] });

test('natural workload identity ignores synthetic Plan instructions and native continuations', () => {
  assert.equal(qaVisibleUserText({parts:[{type:'text',text:'Exact UI workload'},
    {type:'text',synthetic:true,text:'User has requested to enter plan mode.'}]}),'Exact UI workload');
  assert.equal(qaVisibleUserText({parts:[{type:'text',synthetic:true,text:'Continue from where the previous response left off.'}]}),'');
  assert.equal(qaVisibleUserText({parts:[{type:'compaction',auto:true}]}),'');
});

test('natural compaction refuses retired v1 policies and uses the native v2 host pin', () => {
  const policy = nativePolicy();
  assert.equal(policy.threshold, 248400);
  assert.equal(policy.thresholdBasis, 'input-minus-buffer');
  assert.deepEqual(policy.runtimeTarget, hostPin);
  for (const version of ['1.18.31', '1.18.32', '1.18.33']) {
    assert.throws(() => nativePolicy({ version }), /does not match/);
    assert.throws(() => qaNativeTokenUsage({ total: 100 }, { version }), /has not been verified/);
    assert.throws(() => findNaturalCompactionBoundaries(rows(), { ...options(), version }), /has not been verified/);
  }
  for (const override of [{ compaction: { auto: false } }, { modelLimits: undefined }, { modelLimits: { context: 0 } }]) assert.throws(() => nativePolicy(override));
});

test('v2 ceiling follows its input/context buffer policy and never silently applies it to an unverified version', () => {
  const candidate = { version: '2.0.20', source: 'DEVRYAN_QA_OPENCODE_VERSION' };
  const policy = overrides => nativePolicy({ version: candidate.version, target: candidate, ...overrides });
  assert.equal(policy({ compaction: { buffer: 10000 } }).threshold, 266000);
  assert.equal(policy({ compaction: { buffer: 0 } }).threshold, 276000);
  assert.equal(policy({ compaction: { reserved: 1000 }, outputTokenMax: '8000' }).threshold, 248400);
  for (const [context, threshold] of [[31999, 28800], [32000, 16000], [100000, 84000], [200000, 180000]]) {
    const projected = policy({ modelLimits: { context, output: 4000 } });
    assert.equal(projected.threshold, threshold);
    assert.equal(projected.thresholdBasis, 'context-minus-buffer');
  }
  assert.equal(policy({ modelLimits: { context: 0, input: 100000 } }).threshold, 84000);
  for (const buffer of [-1, null, '1000', NaN, Infinity, 276000]) assert.throws(() => policy({ compaction: { buffer } }));
  for (const version of ['1.18.30', '2.0.21', '3.0.0']) {
    assert.throws(() => nativePolicy({ version, target: { ...candidate, version } }), /has not been verified|exact OpenCode version/);
  }
});

test('v2 measured usage includes separate reasoning and cannot prove a native estimated-context trigger', () => {
  const version = '2.0.20';
  assert.equal(qaNativeTokenUsage({ total: 999, input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } }, { version }), 15);
  assert.equal(qaNativeTokenUsage({ total: 999, input: 1, output: 2, cache: { read: 4, write: 5 } }, { version }), null);
  const value = rows();
  value[0].info.tokens.reasoning = 50000;
  assert.equal(qaNativeTokenUsage(value[0].info.tokens, { version }), 306000);
  assert.deepEqual(findNaturalCompactionBoundaries(value, { ...options(), version, threshold: 248400 }), [],
    'Measured usage and a projected summary cannot replace native trigger evidence');
});

test('v2 natural QA records unavailable native evidence before sending any provider prompt', async () => {
  const fixture = createQaProjectFixture({ caseId: 'v2-natural-evidence-unavailable' });
  const priorTarget = process.env.DEVRYAN_QA_OPENCODE_VERSION;
  process.env.DEVRYAN_QA_OPENCODE_VERSION = '2.0.20';
  try {
    await mkdir(fixture.evidenceDirectory, { recursive: true });
    await assert.rejects(runQaNaturalCompaction({
      cell: { transport: 'live', runtime: 'electron', scenarioId: 'compaction-natural', agent: 'builder', planMode: false },
      projectFixture: fixture,
      api: async route => { assert.equal(route, '/api/health'); return { openCodeVersion: '2.0.20' }; },
      sendTurn: async () => assert.fail('unsupported evidence must not spend provider usage'),
      check: async () => assert.fail('unsupported evidence must fail before any live checks'),
    }), { code: 'qa_native_compaction_evidence_unavailable' });
    const evidence = JSON.parse(await readFile(path.join(fixture.evidenceDirectory, 'natural-compaction-evidence.json'), 'utf8'));
    assert.equal(evidence.outcome, 'unavailable');
    assert.equal(evidence.triggerEvidence.state, 'unavailable');
    assert.deepEqual(evidence.boundaries, []);
  } finally {
    if (priorTarget === undefined) delete process.env.DEVRYAN_QA_OPENCODE_VERSION;
    else process.env.DEVRYAN_QA_OPENCODE_VERSION = priorTarget;
    removeQaProjectFixture(fixture);
    await rm(fixture.evidenceDirectory, { recursive: true, force: true });
  }
});

test('historical summary rows and v1 lifecycle events cannot qualify a native v2 boundary', () => {
  assert.deepEqual(findNaturalCompactionBoundaries(rows(), options()), []);
});

test('replay workloads are bounded, deterministic, varied, and semantically checkable', () => {
  const first = createQaNaturalWorkload({ batch: 1, maximumBytes: 8192 });
  assert.deepEqual(createQaNaturalWorkload({ batch: 1, maximumBytes: 8192 }), first);
  assert.notEqual(createQaNaturalWorkload({ batch: 2, maximumBytes: 8192 }).sha256, first.sha256);
  assert.equal(Buffer.byteLength(first.text), first.bytes);
  assert.ok(first.bytes <= 8192 && first.cases > 5);
  assert.match(first.text, /synthetic/); assert.match(first.text, /Implementation remains paused/);
  const cases = first.text.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
  assert.equal(cases.length, first.cases);
  for (const row of cases) {
    let state = { ...row.initial, priority: row.initial.priority ?? 'normal' };
    for (const event of row.arrivals) if (event.revision > state.revision) state = { ...state, ...event.patch, revision: event.revision };
    for (const [key, expected] of Object.entries(row.expected)) assert.equal(state[key], expected);
  }
  assert.throws(() => createQaNaturalWorkload({ batch: 0 }));
  assert.throws(() => createQaNaturalWorkload({ batch: 1, maximumBytes: 1024 * 1024 }));
});

test('natural acceptance cannot run against fixture, unsupported host, or manual cells', async () => {
  for (const cell of [{ transport: 'fixture', runtime: 'electron', scenarioId: 'compaction-natural' },
    { transport: 'live', runtime: 'unsupported', scenarioId: 'compaction-natural' },
    { transport: 'live', runtime: 'electron', scenarioId: 'compaction-manual' }]) {
    await assert.rejects(runQaNaturalCompaction({ cell }), /live web or Electron natural matrix cell/);
  }
});

for (const runtime of ['web', 'electron']) test(`natural ${runtime} Plan captures bind both revisions to exact newly submitted human messages`, async () => {
  const fixture = createQaProjectFixture({ runId: 'natural-submitted-plan' });
  const sessionID = 'ses_natural_submission';
  const ownedPlansRoot = path.join(fixture.evidenceDirectory, 'app-data', 'plans');
  const humanIds = ['msg_human_initial', 'msg_human_revision'];
  const sourceIds = ['msg_plan_initial', 'msg_plan_revision'];
  const names = ['natural-plan-revision-1', 'natural-plan-revision-2'];
  const contents = ['# Initial repair plan\n\nPreserve task state and add persistent priorities.\n',
    '# Revised repair plan\n\nKeep creation order and add a priority filter.\n'];
  const savedPlans = [];
  const captures = [];
  const checks = [];
  const screenshots = [];
  const requests = [];
  const submittedTexts = [];
  let messages = [{ info: { id: 'msg_historical', sessionID, role: 'user' },
    parts: [{ type: 'text', text: 'Earlier input' }] }];
  const stopped = new Error('Controlled stop after both actual natural Plan capture stages');
  try {
    await mkdir(ownedPlansRoot, { recursive: true });
    for (const [index, content] of contents.entries()) {
      const canonicalPath = path.join(ownedPlansRoot, `${sourceIds[index]}.md`);
      const evidencePath = path.join(fixture.evidenceDirectory, `${names[index]}.md`);
      await writeFile(canonicalPath, content);
      await writeFile(evidencePath, content);
      savedPlans.push({ path: evidencePath, canonicalPath, sha256: createHash('sha256').update(content).digest('hex'),
        sourceMessageID: sourceIds[index], userMessageID: humanIds[index], revision: { sessionId: sessionID,
          sourceMessageId: sourceIds[index], directory: fixture.fixtureRoot, sessionCreated: 1_750_000_000_000,
          sessionSlug: 'natural-submission' } });
    }
    const api = async (route, options) => {
      requests.push(route);
      // runQaNaturalCompaction checks against the resolved QA target, so the mock reports it.
      if (route === '/api/health') return { openCodeVersion: resolveQaTargetOpenCodeVersion().version };
      if (route === `/api/config?directory=${encodeURIComponent(fixture.fixtureRoot)}`) return { compaction: { auto: true } };
      const url = new URL(route, 'http://qa.invalid');
      const index = savedPlans.findIndex(saved => url.pathname === `/api/session/${sessionID}/plan-revisions/${saved.sourceMessageID}`);
      assert.notEqual(index, -1, `Unexpected controlled API request: ${route}`);
      assert.deepEqual(Object.fromEntries(url.searchParams), { directory: fixture.fixtureRoot,
        sessionCreated: '1750000000000', sessionSlug: 'natural-submission' });
      assert.equal(options?.cache, 'no-store');
      return { path: savedPlans[index].canonicalPath, content: contents[index] };
    };
    await assert.rejects(runQaNaturalCompaction({
      cell: { transport: 'live', runtime, scenarioId: 'compaction-natural', planMode: true,
        agent: 'builder', providerId: 'qa-provider', modelId: 'qa-model', variant: null, timeoutMs: 5000 },
      projectFixture: fixture, nativeObservationScope: { directory: fixture.fixtureRoot, configurationDigest: 'c'.repeat(64), compaction: { auto: true } }, nativeAgent: 'build', api,
      ui: { attach: async files => assert.deepEqual(files, fixture.attachments.map(item => item.path)) },
      getSessionID: () => sessionID,
      messages: async () => messages,
      sendTurn: async text => {
        const index = submittedTexts.length;
        assert.ok(index < 2, 'This regression must not send a compaction workload or implementation request');
        if (index === 0) {
          assert.match(text, /revision 1, the attached brief controls the proposed task ordering: high, normal, then low/);
          assert.match(text, /Preserve the user-note file verbatim as historical input/);
        } else assert.match(text, /reject the previously proposed automatic priority sorting/);
        submittedTexts.push(text);
        messages = [
          ...messages.map(row => row.info.id === 'msg_historical'
            ? { ...row, parts: [{ type: 'text', text }] } : row),
          { info: { id: humanIds[index], sessionID, role: 'user' }, parts: [{ type: 'text', text },
            { type: 'text', synthetic: true, text: 'User has requested to enter plan mode.' },
            { type: 'text', text: 'Native attachment caption' }] },
          { info: { id: sourceIds[index], sessionID, role: 'assistant', parentID: humanIds[index],
            finish: 'stop', time: { created: 100 + index, completed: 200 + index } },
            parts: [{ type: 'text', text: '<!--plan-->\n' + contents[index] }] },
          { info: { id: `msg_synthetic_${index}`, sessionID, role: 'user' },
            parts: [{ type: 'text', text, synthetic: true }] },
          { info: { id: `msg_compaction_${index}`, sessionID, role: 'user' },
            parts: [{ id: `prt_compaction_${index}`, type: 'compaction', auto: true }, { type: 'text', text }] },
        ];
        return messages;
      },
      captureSavedPlan: async (name, options) => {
        const index = captures.length;
        assert.equal(name, names[index]);
        assert.deepEqual(options, { userMessageID: humanIds[index] });
        captures.push({ name, userMessageID: options.userMessageID });
        return savedPlans[index];
      },
      readSavedRevision: revision => readQaSavedPlanRevision(api, revision, ownedPlansRoot),
      readProviderObservation: async () => [{ stage: 'model-prepared', kind: 'primary', sessionID,
        directory: `<WORKTREE_${createHash('sha256').update(fixture.fixtureRoot).digest('hex').slice(0, 12)}>`, configurationDigest: 'c'.repeat(64),
        requestID: 'prepared_unit_only', modelLimits: { context: 200000, output: 32000 } }],
      screenshot: async name => { screenshots.push(name); },
      check: async (name, action) => {
        checks.push(name);
        await action();
        // Both production planning stages execute. Native compaction itself is outside this unit regression.
        if (checks.length === 2) throw stopped;
      },
    }), error => error === stopped);
    assert.deepEqual(captures, names.map((name, index) => ({ name, userMessageID: humanIds[index] })));
    assert.deepEqual(checks, ['investigate and save a paused plan before natural context growth',
      'replace the saved plan with revision 2 and preserve the pause']);
    assert.deepEqual(screenshots, ['natural-diagnosis', 'natural-revised-plan']);
    assert.equal(submittedTexts.length, 2);
    assert.ok(requests.includes('/api/health'));
    const evidence = JSON.parse(await readFile(path.join(fixture.evidenceDirectory, 'natural-compaction-evidence.json'), 'utf8'));
    assert.deepEqual(evidence.plans.map(saved => saved.userMessageID), humanIds);
    assert.equal(evidence.expectedPausedState.planReference.userMessageID, humanIds[1]);
    assert.equal(evidence.expectedPausedState.planReference.identity.sourceMessageId, sourceIds[1]);
  } finally {
    removeQaProjectFixture(fixture);
    await rm(fixture.evidenceDirectory, { recursive: true, force: true });
  }
});


test('natural prefill keeps a separate explicit workload estimate below the unchanged native threshold', () => {
  const threshold = 468000;
  const target = deriveQaNaturalPrefillTarget(threshold);
  assert.deepEqual(target, { source: 'qa-prefill-estimate-only', threshold, seedHeadroomTokens: 20000, targetUsage: 448000 });
  assert.equal(deriveQaNaturalPrefillTarget(100000).targetUsage, 90000);
  for (const invalid of [0, -1, NaN, undefined]) assert.throws(() => deriveQaNaturalPrefillTarget(invalid));
});

test('early native boundaries cannot be hidden by waiting for a complete summary or restarting after seed', () => {
  const previousPartIds = ['prt_before_observation'];
  const sample = [{ info: { id: 'msg_before' }, parts: [{ id: previousPartIds[0], type: 'compaction', auto: true }] },
    { info: { id: 'msg_prefill' }, parts: [{ id: 'prt_during_prefill', type: 'compaction', auto: true }] }];
  const observations = [{ kind: 'native.compacting', sessionID: 'ses_root', at: 95 },
    { kind: 'native.compacting', sessionID: 'ses_other', at: 115 },
    { kind: 'native.compacting', sessionID: 'ses_root', at: 120 }];
  const result = projectQaEarlyNaturalBoundary(sample, { previousPartIds, observations, sessionID: 'ses_root', startedAt: 100 });
  assert.deepEqual(result.partIds, ['prt_during_prefill']);
  assert.deepEqual(result.nativeEvents, [observations[2]]);
  const hookOnly = projectQaEarlyNaturalBoundary([], { previousPartIds, observations, sessionID: 'ses_root', startedAt: 100 });
  assert.equal(hookOnly.nativeEvents.length, 1, 'A native hook is enough to reject an early boundary before a summary is persisted');
});

test('natural phases seed one distinct bounded witness per boundary without changing manual mixed coverage', () => {
  assert.deepEqual(QA_NATURAL_COMPACTION_PHASES.map(item => item.coverage), ['active', 'completed-awaiting']);
  for (const [index, phase] of QA_NATURAL_COMPACTION_PHASES.entries()) {
    const prompt = createQaNaturalInvestigationPrompt(index + 1);
    assert.match(prompt, /Start exactly one independent read-only task/);
    assert.ok(prompt.includes(phase.marker));
    assert.equal(prompt.includes(QA_NATURAL_COMPACTION_PHASES[1 - index].marker), false);
    assert.match(prompt, /finish as soon as its assigned bounded work is complete/);
    assert.match(prompt, /Do not ask it to sleep, poll, wait for compaction or prolong its work/);
    assert.match(prompt, /do not suppress automatically delivered managed continuation instructions/);
    assert.match(prompt, /Preserve the implementation pause/);
  }
  for (const boundary of [0, 3, undefined]) assert.throws(() => createQaNaturalInvestigationPrompt(boundary));
});

test('second-phase prefill excludes only exact previously recorded native events without moving the observation start', () => {
  const previousNativeEvents = options().observations;
  const unexpected = { kind: 'native.compacting', sessionID: 'ses_root', at: 250 };
  const result = projectQaEarlyNaturalBoundary(rows(), { previousPartIds: ['prt_auto'], previousNativeEvents,
    observations: [...previousNativeEvents, unexpected], sessionID: 'ses_root', startedAt: 95 });
  assert.deepEqual(result.partIds, []);
  assert.deepEqual(result.nativeEvents, [unexpected]);
  const missingPrior = projectQaEarlyNaturalBoundary(rows(), { previousPartIds: ['prt_auto'], previousNativeEvents: [],
    observations: previousNativeEvents, sessionID: 'ses_root', startedAt: 95 });
  assert.equal(missingPrior.nativeEvents.length, 2, 'Known message IDs alone cannot discard independent native observations');
});

test('a seed turn without a new managed start is detected immediately', () => {
  const start = (callID) => ({ type: 'tool', tool: 'devryan_task', callID, state: { status: 'completed', input: { action: 'start', prompt: 'x' } } });
  const rows = [
    { info: { role: 'assistant' }, parts: [start('call_witness_1'), { type: 'tool', tool: 'devryan_task', callID: 'call_status', state: { input: { action: 'status' } } }] },
    { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'I can’t start another specialist investigation in this planning phase.' }] },
  ];
  assert.deepEqual(findQaSeededInvestigationStarts(rows, new Set(['call_witness_1'])), []);
  assert.deepEqual(findQaSeededInvestigationStarts([...rows, { info: { role: 'assistant' }, parts: [start('call_witness_2')] }], new Set(['call_witness_1'])), ['call_witness_2']);
  assert.deepEqual(findQaSeededInvestigationStarts(undefined), []);
});
