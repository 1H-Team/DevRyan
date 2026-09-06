import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createQaNaturalWorkload, createQaNaturalInvestigationPrompt, QA_NATURAL_COMPACTION_PHASES, deriveQaNativeCompactionPolicy, deriveQaNaturalPrefillTarget, findNaturalCompactionBoundaries, projectQaEarlyNaturalBoundary,
  qaNativeTokenUsage, qaVisibleUserText, runQaNaturalCompaction } from './natural-compaction-scenarios.mjs';
import { readQaSavedPlanRevision } from './compaction-approval.mjs';
import { createQaProjectFixture, removeQaProjectFixture } from './project-fixture.mjs';

const nativePolicy = overrides => deriveQaNativeCompactionPolicy({ version: '1.18.29',
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

test('native input reserve controls the pinned OpenAI threshold, including effective overrides', () => {
  const policy = nativePolicy();
  assert.equal(policy.threshold, 256000);
  assert.equal(policy.thresholdBasis, 'input-minus-reserved');
  assert.equal(policy.maximumOutput, 32000);
  assert.equal(nativePolicy({ compaction: { reserved: 10000 } }).threshold, 266000);
  assert.equal(nativePolicy({ outputTokenMax: '8000' }).threshold, 268000);
  assert.equal(nativePolicy({ modelLimits: { context: 200000, input: null, output: 64000 } }).threshold, 168000);
  assert.equal(nativePolicy({ modelLimits: { context: 200000, input: 0, output: 4000 } }).threshold, 196000);
  assert.equal(nativePolicy({ modelLimits: { context: 200000, output: 0 } }).maximumOutput, 32000);
  for (const override of [{ version: '1.18.27' }, { compaction: { auto: false } }, { modelLimits: undefined },
    { modelLimits: { context: 0, output: 1000 } }, { outputTokenMax: 'not-a-number' }, { compaction: { reserved: -1 } }]) {
    assert.throws(() => nativePolicy(override));
  }
});

test('usage follows the native total-or-components contract without inventing missing values', () => {
  assert.equal(qaNativeTokenUsage({ total: 258000 }), 258000);
  assert.equal(qaNativeTokenUsage({ total: 0, input: 200000, output: 4000, cache: { read: 50000, write: 2000 } }), 256000);
  assert.equal(qaNativeTokenUsage({ input: 200000, output: 1 }), null);
  assert.equal(qaNativeTokenUsage(undefined), null);
});

test('natural boundary requires typed automatic compaction and an exact completed summary', () => {
  const boundary = findNaturalCompactionBoundaries(rows(), options())[0];
  assert.equal(boundary.eventId, 'prt_auto');
  assert.equal(boundary.summaryMessageId, 'msg_summary');
  assert.equal(boundary.usageMessageId, 'msg_usage');
  assert.equal(boundary.thresholdReached, true);
  assert.equal(boundary.nativeLifecycle, 'observed');
  assert.match(boundary.summarySha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(findNaturalCompactionBoundaries(rows(), { ...options(), previousPartIds: ['prt_auto'] }), []);
  for (const mutate of [
    value => { value[1].parts = [{ type: 'text', text: 'Automatic summary recap' }]; },
    value => { value[1].parts[0].auto = false; },
    value => { value[2].info.parentID = 'other'; },
    value => { value[2].info.summary = false; },
    value => { delete value[2].info.time.completed; },
    value => { value[2].info.error = { name: 'APIError' }; },
    value => { value[2].parts[0].text = ' '; },
  ]) {
    const value = rows(); mutate(value);
    assert.deepEqual(findNaturalCompactionBoundaries(value, options()), []);
  }
});

test('threshold and lifecycle claims use the adjacent turn and exact native session window', () => {
  const value = rows();
  value.unshift({ info: { id: 'historical', role: 'assistant', time: { completed: 10 }, tokens: { total: 999999 } }, parts: [] });
  value[1].info.tokens = { total: 100000 };
  value[2].parts[0].overflow = true;
  const boundary = findNaturalCompactionBoundaries(value, options())[0];
  assert.equal(boundary.thresholdReached, false);
  assert.equal(boundary.overflow, true);
  assert.equal(boundary.usageAtTrigger, 100000);
  for (const observations of [[], [{ kind: 'native.compacting', sessionID: 'other', at: 102 },
    { kind: 'native.session.compacted', sessionID: 'other', at: 205 }],
  [{ kind: 'native.compacting', sessionID: 'ses_root', at: 20 }, { kind: 'native.session.compacted', sessionID: 'ses_root', at: 30 }],
  [{ kind: 'native.compacting', sessionID: 'ses_root', at: 6000 }, { kind: 'native.session.compacted', sessionID: 'ses_root', at: 6001 }],
  [{ kind: 'native.session.compacted', sessionID: 'ses_root', at: 110 }, { kind: 'native.compacting', sessionID: 'ses_root', at: 190 }],
  [{ kind: 'native.compacting', sessionID: 'ses_root', at: 210 }, { kind: 'native.session.compacted', sessionID: 'ses_root', at: 220 }]]) {
    assert.equal(findNaturalCompactionBoundaries(rows(), { ...options(), observations })[0].nativeLifecycle, 'missing');
  }
});

test('two natural boundaries cannot reuse one observed native lifecycle cycle', () => {
  const value=rows();const second=structuredClone(value.slice(1));
  second[0].info.id='msg_auto_2';second[0].parts[0].id='prt_auto_2';
  second[1].info.id='msg_summary_2';second[1].info.parentID='msg_auto_2';second[1].info.time.completed=202;
  const found=findNaturalCompactionBoundaries([...value,...second],options());
  assert.deepEqual(found.map(boundary=>boundary.nativeLifecycle),['observed','missing']);
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

test('natural acceptance cannot run against fixture, web, or manual cells', async () => {
  for (const cell of [{ transport: 'fixture', runtime: 'electron', scenarioId: 'compaction-natural' },
    { transport: 'live', runtime: 'web', scenarioId: 'compaction-natural' },
    { transport: 'live', runtime: 'electron', scenarioId: 'compaction-manual' }]) {
    await assert.rejects(runQaNaturalCompaction({ cell }), /live Electron natural matrix cell/);
  }
});

test('natural Plan captures bind both revisions to exact newly submitted human messages', async () => {
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
      if (route === '/api/health') return { openCodeVersion: '1.18.29' };
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
      cell: { transport: 'live', runtime: 'electron', scenarioId: 'compaction-natural', planMode: true,
        agent: 'builder', providerId: 'qa-provider', modelId: 'qa-model', variant: null, timeoutMs: 5000 },
      projectFixture: fixture, nativeAgent: 'build', api,
      ui: { attach: async files => assert.deepEqual(files, fixture.attachments.map(item => item.path)) },
      getSessionID: () => sessionID,
      messages: async () => messages,
      sendTurn: async text => {
        const index = submittedTexts.length;
        assert.ok(index < 2, 'This regression must not send a compaction workload or implementation request');
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
      readProviderObservation: async () => [{ kind: 'chat.params', sessionID, providerID: 'qa-provider', modelID: 'qa-model',
        modelLimits: { context: 200000, output: 32000 } }],
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
