import test from 'node:test';
import assert from 'node:assert/strict';
import { createQaClaudeBudget, gradeQaFocusedTools, selectQaAdvertisedClaudeDefault, openQaClaudeBudget, findQaDispatchedTurn, gradeQaFollowup } from './focused-provider.mjs';
import { validateQaMatrixConfig } from './matrix-config.mjs';
const now = 1800000000000, resetAt = now + 18000000;
const quota = usedPercent => ({ providerId: 'claude', ok: true, configured: true, usageUpdatedAt: now,
  usage: { windows: { '5h': { usedPercent, resetAt, windowSeconds: 18000 } } } });

test('Claude routine budget shares one baseline across arms and preserves four points', () => {
  const budget = createQaClaudeBudget({ now: () => now });
  assert.equal(budget.sample(quota(30), { before: true }).consumed, 0);
  assert.equal(budget.sample(quota(32)).consumed, 2);
  assert.equal(budget.sample(quota(32), { before: true }).consumed, 2);
  assert.throws(() => budget.sample(quota(36)), { code: 'qa_claude_budget_exhausted' });
  assert.throws(() => budget.sample(quota(32), { before: true }), { code: 'qa_claude_budget_stopped' });
});

test('Claude budget fails closed on stale, absent, reset, decreased and between-turn changes', () => {
  for (const change of [row => { row.ok = false; }, row => { row.usageUpdatedAt -= 16000; },
    row => { delete row.usage.windows['5h']; }, row => { row.usage.windows['5h'].resetAt++; },
    row => { row.usage.windows['5h'].usedPercent--; }, row => { row.usage.windows['5h'].usedPercent++; }]) {
    const budget = createQaClaudeBudget({ now: () => now }); budget.sample(quota(30), { before: true });
    budget.sample(quota(31)); const next = quota(31); change(next);
    assert.throws(() => budget.sample(next, { before: true }));
  }
});

test('retests retain original window and total ten-point authorization', () => {
  const budget = createQaClaudeBudget({ baseline: { usedPercent: 30, resetAt }, retest: true, now: () => now });
  assert.equal(budget.sample(quota(37), { before: true }).consumed, 7);
  assert.throws(() => budget.sample(quota(40)), { code: 'qa_claude_budget_exhausted' });
});

test('focused provider cells accept both native providers and hosts with strict bounded scope', () => {
  for (const providerId of ['anthropic', 'cursor-acp']) for (const runtime of ['web', 'electron']) {
    const cell = { id: `${providerId}-${runtime}`, runtime, transport: 'live', providerId, modelId: 'exact-model', agent: 'builder',
      planMode: false, variant: 'medium', scenarioIds: ['focused-provider'], repetitions: 1, timeoutMs: 60000 };
    const config = { schemaVersion: 1, evidenceRoot: '.cache/qa/focused-test', cells: [cell] };
    assert.equal(validateQaMatrixConfig(config).cells[0].providerId, providerId);
    for (const patch of [{ repetitions: 2 }, { planMode: true }, { agent: 'orchestrator' }, { providerId: 'openai' },
      { scenarioIds: ['focused-provider', 'project-work'] }]) assert.throws(() => validateQaMatrixConfig({ ...config, cells: [{ ...cell, ...patch }] }));
  }
});


test('focused tools require actual file bytes, publication scope and a confined successful receipt', async t => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'devryan-focused-tools-')); t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'focused-provider-proof.txt'), 'DevRyan native tool proof\n');
  const row = { info: { id: 'msg_assistant', sessionID: 'ses_test' }, parts: [
    { type: 'tool', tool: 'read', callID: 'call_read', state: { status: 'completed', input: { filePath: join(directory, 'src/tasks.mjs') } } },
    { type: 'tool', tool: 'write', callID: 'call_write', state: { status: 'completed', input: { filePath: join(directory, 'focused-provider-proof.txt') } } },
  ] };
  const lease = { state: 'published', executionKind: 'process', directory, scope: { sessionID: 'ses_test', callID: 'call_write', messageID: 'msg_assistant' }, result: { operationID: 'op_test' } };
  const receipt = { terminated: true, confined: true, cancelled: false, exitCode: 0 };
  const input = { rows: [row], sessionID: 'ses_test', directory, storage: directory, leaseForCall: async () => lease, readReceipt: async () => receipt };
  assert.equal((await gradeQaFocusedTools(input)).publication, 'published');
  for (const change of [() => { lease.scope.messageID = 'other'; }, () => { receipt.confined = false; }, () => { receipt.exitCode = 1; }]) {
    const beforeLease = structuredClone(lease), beforeReceipt = structuredClone(receipt); change();
    await assert.rejects(gradeQaFocusedTools(input)); Object.assign(lease, beforeLease); Object.assign(receipt, beforeReceipt);
  }
  await writeFile(join(directory, 'focused-provider-proof.txt'), 'wrong'); await assert.rejects(gradeQaFocusedTools(input));
});


test('Claude selection uses only canonical advertised default and requires tool support', () => {
  const catalog = { default: { anthropic: 'claude-advertised' }, all: [{ id: 'anthropic', models: { 'claude-advertised': { capabilities: { toolcall: true } } } }] };
  assert.deepEqual(selectQaAdvertisedClaudeDefault(catalog), { providerID: 'anthropic', modelID: 'claude-advertised', variant: null, source: 'canonical-provider-default' });
  for (const value of [{ ...catalog, default: {} }, { ...catalog, all: [] }, { ...catalog, all: [...catalog.all, ...catalog.all] },
    { ...catalog, all: [{ id: 'anthropic', models: { 'claude-advertised': { capabilities: { toolcall: false } } } }] }]) assert.throws(() => selectQaAdvertisedClaudeDefault(value));
});


test('Claude reserve reduces routine headroom near account exhaustion', () => {
  for (const used of [96, 97, 100]) {
    const budget = createQaClaudeBudget({ now: () => now });
    assert.throws(() => budget.sample(quota(used), { before: true }), { code: 'qa_claude_budget_exhausted' });
  }
  const budget = createQaClaudeBudget({ now: () => now });
  assert.equal(budget.sample(quota(94), { before: true }).routineLimit, 2);
  assert.throws(() => budget.sample(quota(96)), { code: 'qa_claude_budget_exhausted' });
});

test('attended source persists original budget and refuses interrupted in-flight traffic after reopening', async t => {
  const { mkdtemp, rm, mkdir } = await import('node:fs/promises'); const { resolve } = await import('node:path');
  await mkdir(resolve('.cache'), { recursive: true });
  const directory = await mkdtemp(resolve('.cache/focused-budget-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await openQaClaudeBudget(directory, { now: () => now });
  await first.sample(quota(30), { before: true }); await first.sample(quota(32));
  const resumed = await openQaClaudeBudget(directory, { now: () => now });
  assert.equal((await resumed.sample(quota(32), { before: true })).consumed, 2);
  const interrupted = await openQaClaudeBudget(directory, { now: () => now });
  await assert.rejects(interrupted.sample(quota(32), { before: true }), { code: 'qa_claude_budget_stopped' });
  const reopened = await openQaClaudeBudget(directory, { now: () => now });
  await assert.rejects(reopened.sample(quota(32), { before: true }), { code: 'qa_claude_budget_stopped' });
});

test('cancellation dispatch requires matching physical request, preparation and current user step attempt', () => {
  const common = { sessionID: 'ses_test', controllerInstanceID: 'controller', configurationDigest: 'digest', directory: '/fixture' };
  const execution = { providerID: 'anthropic', modelID: 'model', agent: 'builder', variant: null }, attempt = { traceID: 'trace', spanID: 'span' };
  const rows = [
    { ...common, stage: 'step-link', userMessageID: 'msg_user', assistantMessageID: 'msg_assistant', execution, attempt },
    { ...common, stage: 'model-prepared', kind: 'primary', requestID: 'request', execution },
    { ...common, stage: 'physical', kind: 'primary', requestID: 'request', attempt, ordinal: 1 },
  ];
  const scope = { sessionID: 'ses_test', userMessageID: 'msg_user', providerID: 'anthropic', modelID: 'model' };
  assert.equal(findQaDispatchedTurn(rows, scope).requestID, 'request');
  for (const change of [copy => copy.pop(), copy => { copy[2].attempt = null; }, copy => { copy[2].attempt = { ...copy[2].attempt, spanID: 'other' }; },
    copy => { copy[1].requestID = 'other'; }, copy => { copy[0].userMessageID = 'previous'; }, copy => { copy[2].controllerInstanceID = 'other'; }]) {
    const copy = structuredClone(rows); change(copy); assert.equal(findQaDispatchedTurn(copy, scope), null);
  }
});

test('follow-up checks the new canonical response for exact first-reply recall', () => {
  const row = { info: { role: 'assistant', id: 'msg_reply', parentID: 'msg_followup' }, parts: [{ type: 'text', text: 'DevRyan live QA ready.' }] };
  assert.equal(gradeQaFollowup([row], 'msg_followup').exactRecall, true);
  assert.throws(() => gradeQaFollowup([row], 'msg_other'));
  const wrong = structuredClone(row); wrong.parts[0].text = 'Earlier reply was DevRyan live QA ready.';
  assert.throws(() => gradeQaFollowup([wrong], 'msg_followup'));
});


test('credential-free input preparation removes partial handoff output after artifact failure', async t => {
  const { prepareFocusedProviderInputs } = await import('./focused-provider-inputs.mjs');
  const { mkdtemp, mkdir, rm, access } = await import('node:fs/promises'); const { resolve, join } = await import('node:path');
  await mkdir(resolve('.cache'), { recursive: true });
  const root = await mkdtemp(resolve('.cache/focused-inputs-')); t.after(() => rm(root, { recursive: true, force: true }));
  const artifactRoot = join(root, 'artifacts'); await mkdir(artifactRoot, { mode: 0o700 });
  const outputRoot = join(root, 'handoff');
  await assert.rejects(prepareFocusedProviderInputs({ artifactRoot, outputRoot, providerId: 'cursor-acp', modelId: 'grok-4.6', variant: 'medium' }));
  await assert.rejects(access(outputRoot), { code: 'ENOENT' });
});
