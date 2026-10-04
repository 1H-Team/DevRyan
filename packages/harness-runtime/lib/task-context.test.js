import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { COMPACTION_ANCHOR_TAG, createTaskContextRuntime, deriveTaskCheckpoint, formatChildCompactionAnchor, formatCompactionAnchor, planReference } from './task-context.js';

const anchor = { info: { id: 'msg_user', sessionID: 'ses_root', role: 'user' }, parts: [
  { type: 'text', text: 'Keep dependencies unchanged. Implement the selected plan.' },
  { type: 'text', synthetic: true, text: '[openchamber-plan-action:v1] {"action":"implement","sourceSessionId":"ses_root","sourceMessageId":"msg_plan","planIndex":0}' },
] };
const base = { session: { id: 'ses_root', directory: '/project' }, anchor, projectKey: 'project-a',
  primary: { anchorID: 'msg_user', state: 'recovering', attemptCount: 1, todoContinuationCount: 2, cancellationGeneration: 0, guardedIDs: ['msg_recovery'] },
  tasks: [{ taskId: 'dvr_task_active', rootSessionId: 'ses_root', childSessionId: 'ses_child', status: 'running', requiredChecks: [{ name: 'unit' }] },
    { taskId: 'dvr_task_done', rootSessionId: 'ses_root', childSessionId: 'ses_done', status: 'failed', failureReason: 'Required check failed' }],
  envelopes: [{ taskId: 'dvr_task_done', rootSessionId: 'ses_root', envelopeId: 'dvr_result_done', action: null }],
  todos: [{ id: 'todo_1', content: 'Reconcile the failed check', status: 'pending' }], now: 100 };

test('selected plan references require one canonical synthetic implement marker', () => {
  const marker = { action: 'implement', sourceSessionId: 'ses_root', sourceMessageId: 'msg_plan', planIndex: 0, projectDirectory: '/project/pkg' };
  const selected = (value) => ({ ...anchor, parts: [{ type: 'text', synthetic: true, text: `[openchamber-plan-action:v1] ${JSON.stringify(value)}` }] });
  expect(planReference(selected(marker))).toEqual({ sourceSessionId: 'ses_root', sourceMessageId: 'msg_plan', planIndex: 0, projectDirectory: '/project/pkg' });
  for (const value of [null, { ...marker, action: 'view' }, { ...marker, sourceSessionId: '../other' }, { ...marker, sourceMessageId: '' },
    { ...marker, planIndex: -1 }, { ...marker, projectDirectory: 'relative' }, { ...marker, projectDirectory: 1 }]) expect(planReference(selected(value))).toBeNull();
  const ordinary = selected(marker); ordinary.parts[0].synthetic = false; expect(planReference(ordinary)).toBeNull();
  const assistant = selected(marker); assistant.info = { ...anchor.info, role: 'assistant' }; expect(planReference(assistant)).toBeNull();
  const duplicate = selected(marker); duplicate.parts.push({ ...duplicate.parts[0] }); expect(planReference(duplicate)).toBeNull();
});

describe('recoverable task checkpoints', () => {
  test.each(['manual', 'natural'])('preserves objective, plan, children and recovery across two %s boundaries', () => {
    let checkpoint;
    for (let i = 1; i <= 2; i++) checkpoint = deriveTaskCheckpoint({ ...base,
      primary: { ...base.primary, activeUserID: `msg_compaction_${i}` }, now: i * 100 });
    expect(checkpoint.anchor.messageID).toBe('msg_user');
    expect(checkpoint.anchor.objective).toContain('Keep dependencies unchanged');
    expect(checkpoint.selectedPlan).toEqual({ sourceSessionId: 'ses_root', sourceMessageId: 'msg_plan', planIndex: 0 });
    expect(checkpoint.children.map((entry) => entry.status)).toEqual(['running', 'failed']);
    expect(checkpoint.recovery).toMatchObject({ attemptCount: 1, readOnly: true, todoContinuationCount: 2 });
    expect(checkpoint.nextAction.kind).toBe('inspect-managed-barrier');
  });
  test('does not turn an old pass into current verification or lose a critical check failure', () => {
    const task = { ...base.tasks[0], requiredChecks: [{ name: 'unit' }, { name: 'lint' }], requiredCheckReceipts: [
      { name: 'unit', status: 'passed', callId: 'call_pass', messageId: 'msg_pass' },
      { name: 'lint', status: 'failed', callId: 'call_fail', messageId: 'msg_fail' },
    ] };
    const result = deriveTaskCheckpoint({ ...base, tasks: [task] });
    expect(result.children[0].checks).toEqual([
      { name: 'unit', status: 'not-observed', lastObservation: 'passed', callId: 'call_pass', messageId: 'msg_pass' },
      { name: 'lint', status: 'failed', lastObservation: 'failed', callId: 'call_fail', messageId: 'msg_fail' },
    ]);
  });
  test('bounds views without changing the task graph and names missing evidence explicitly', () => {
    const tasks = Array.from({ length: 250 }, (_, i) => ({ ...base.tasks[0], taskId: `dvr_task_${i}` }));
    const result = deriveTaskCheckpoint({ ...base, tasks });
    expect(result.childCoverage).toEqual({ returned: 100, total: 250, complete: false });
    expect(tasks).toHaveLength(250);
    const long = structuredClone(anchor); long.parts[0].text = 'x'.repeat(20_000);
    const partial = deriveTaskCheckpoint({ ...base, anchor: long });
    expect(partial.anchor.complete).toBe(false);
    expect(partial.nextAction).toEqual({ kind: 'retrieve-objective', messageID: 'msg_user' });
  });
  test('rejects synthetic compaction or a foreign message as a real-user anchor', () => {
    expect(() => deriveTaskCheckpoint({ ...base, anchor: { info: anchor.info, parts: [{ type: 'compaction', auto: true }] } })).toThrow('context_anchor_unavailable');
    expect(() => deriveTaskCheckpoint({ ...base, anchor: { ...anchor, info: { ...anchor.info, sessionID: 'ses_other' } } })).toThrow('context_anchor_unavailable');
  });
});

describe('project decisions with scoped provenance', () => {
  let directory, runtime, currentHash, clock;
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-project-context-'));
    currentHash = 'a'.repeat(64); clock = 100;
    runtime = createTaskContextRuntime({ dataDirectory: directory, now: () => clock,
      readScope: async ({ sessionID, directory: projectDirectory }) => ({ session: { id: sessionID, directory: projectDirectory },
        projectIdentity: projectDirectory, projectDirectory }),
      readTaskState: async () => base,
      readMessage: async () => anchor,
      fingerprintFiles: async () => currentHash,
      sanitizeText: (value) => value.replace('private-token', '[REDACTED]'),
    });
  });
  afterEach(async () => { await runtime.drain(); await fs.rm(directory, { recursive: true, force: true }); });
  const decision = (extra = {}) => ({ sessionID: 'ses_root', directory: '/project', sourceMessageID: 'msg_user',
    statement: 'Keep dependencies unchanged.', paths: ['package.json'], ...extra });
  test('retrieves a relevant older sourced decision, invalidates changed content, and isolates projects', async () => {
    const saved = await runtime.rememberDecision(decision());
    expect((await runtime.decisions(decision({ query: 'dependencies' })))[0]).toMatchObject({ id: saved.id, validity: 'active' });
    clock = 100000;
    expect((await runtime.decisions(decision({ query: 'dependencies' })))[0].id).toBe(saved.id);
    currentHash = 'b'.repeat(64);
    expect((await runtime.decisions(decision()))[0].validity).toBe('stale');
    expect(await runtime.decisions(decision({ directory: '/other-project' }))).toEqual([]);
  });
  test('requires an exact canonical user quote and keeps expiry and supersession explicit', async () => {
    await expect(runtime.rememberDecision(decision({ statement: 'The assistant believes tests passed.' }))).rejects.toThrow('canonical_user_quote');
    const saved = await runtime.rememberDecision(decision({ validUntil: 200 }));
    clock = 201;
    expect((await runtime.decisions(decision()))[0].validity).toBe('expired');
    const replacement = await runtime.rememberDecision(decision({ statement: 'Implement the selected plan.', paths: [], supersedes: saved.id }));
    expect(replacement.supersedes).toBe(saved.id);
    expect((await runtime.decisions(decision())).find((entry) => entry.id === saved.id).validity).toBe('superseded');
  });
  test('makes duplicate writes idempotent and does not let another task claim the source', async () => {
    const first = await runtime.rememberDecision(decision());
    expect(await runtime.rememberDecision(decision())).toEqual(first);
    expect(await runtime.decisions(decision())).toHaveLength(1);
    await expect(runtime.rememberDecision(decision({ sessionID: 'ses_other' }))).rejects.toThrow('canonical_user_quote');
    await expect(runtime.rememberDecision(decision({ statement: 'private-token' }))).rejects.toThrow('invalid_statement');
    await expect(runtime.rememberDecision(decision({ paths: ['../other'] }))).rejects.toThrow('invalid_paths');
  });
});

describe('compaction anchors', () => {
  test('are deterministic, bounded, and carry objective, plan, todos, children and next action', () => {
    const checkpoint = deriveTaskCheckpoint({ ...base, now: 0 });
    const text = formatCompactionAnchor(checkpoint, { planPath: '/data/projects/p/plans/1-slug-msg_plan.md', planOutline: '# Plan\n- Step 1\n- Step 2' });
    expect(text).toBe(formatCompactionAnchor(deriveTaskCheckpoint({ ...base, now: 0 }), { planPath: '/data/projects/p/plans/1-slug-msg_plan.md', planOutline: '# Plan\n- Step 1\n- Step 2' }));
    expect(text.startsWith(COMPACTION_ANCHOR_TAG)).toBe(true);
    expect(text).toContain('## Objective anchor');
    expect(text).toContain('Keep dependencies unchanged. Implement the selected plan.');
    expect(text).toContain('File: /data/projects/p/plans/1-slug-msg_plan.md');
    expect(text).toContain('- Step 2');
    expect(text).toContain('- [pending] Reconcile the failed check');
    expect(text).toContain('dvr_task_active running');
    expect(text).toContain('Recovery is read-only');
    expect(text).toContain('Inspect the outstanding sub-agent tasks');
    expect(text).not.toMatch(/updatedAt|\b1\d{12}\b/);
  });

  test('shed the plan outline, then detail, before shortening the objective', () => {
    const long = structuredClone(anchor); long.parts[0].text = `${'objective '.repeat(1_500)}`;
    const todos = Array.from({ length: 20 }, (_, i) => ({ id: `todo_${i}`, content: 'x'.repeat(400), status: 'pending' }));
    const tasks = Array.from({ length: 40 }, (_, i) => ({ taskId: `dvr_task_${i}`, rootSessionId: 'ses_root', childSessionId: `ses_${i}`, status: 'running' }));
    const text = formatCompactionAnchor(deriveTaskCheckpoint({ ...base, anchor: long, todos, tasks, now: 0 }), { planPath: '/p.md', planOutline: '- step\n'.repeat(2_000) });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(12 * 1024);
    expect(text).toContain('truncated');
    expect(text).not.toContain('- step');
    expect(text).toContain('(more tasks outstanding)');
  });

  test('spends optional detail budget on a complete 7 KiB objective and its trailing restriction', () => {
    const objective = `${'x'.repeat(7 * 1024)}\nDo not change dependencies or permissions.`;
    const long = { ...anchor, parts: [{ type: 'text', text: objective }] };
    const todos = Array.from({ length: 20 }, (_, i) => ({ id: `todo_${i}`, content: 'optional '.repeat(70), status: 'pending' }));
    const tasks = Array.from({ length: 40 }, (_, i) => ({ ...base.tasks[0], taskId: `dvr_task_${i}` }));
    const text = formatCompactionAnchor(deriveTaskCheckpoint({ ...base, anchor: long, todos, tasks }),
      { planPath: '/plan.md', planOutline: '- optional outline\n'.repeat(400) });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(12 * 1024);
    expect(text).toContain(objective);
    expect(text).toContain('File: /plan.md');
    expect(text).toContain('Recovery is read-only');
    expect(text).not.toContain('- optional outline');
    expect(text).not.toContain('user message msg_user, truncated');
  });

  test.each([11_800, 20_000])('keeps incomplete scope explicit across two compactions of %i bytes', (bytes) => {
    const long = { ...anchor, parts: [{ type: 'text', text: 'é'.repeat(bytes / 2) }] };
    for (let i = 1; i <= 2; i++) {
      const checkpoint = deriveTaskCheckpoint({ ...base, anchor: long, tasks: [], envelopes: [], todos: [],
        primary: { ...base.primary, activeUserID: `msg_summary_${i}` } });
      if (bytes < 12 * 1024) expect(checkpoint.anchor.complete).toBe(true);
      const text = formatCompactionAnchor(checkpoint);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(12 * 1024);
      expect(text).toContain('user message msg_user, truncated');
      expect(text).toContain('Objective incomplete:');
      expect(text).toContain('request the missing scope before making changes');
      expect(text).toContain('Preserve any Objective incomplete marker in every later summary');
      expect(text).toContain('Recovery is read-only');
      expect(text).not.toContain('re-read');
      expect(text).not.toContain('\uFFFD');
    }
  });

  test('never cuts an oversized child envelope into invalid JSON', () => {
    const text = formatChildCompactionAnchor(`Rule\n${JSON.stringify({ prompt: 'x'.repeat(20_000) })}`);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(12 * 1024);
    expect(text).toContain('Assignment incomplete:');
    expect(text).not.toContain('{"prompt":');
  });

  test('the runtime anchor writes no record and a managed child gets its assignment', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-anchor-'));
    const writes = [];
    const runtime = createTaskContextRuntime({ dataDirectory: directory,
      store: { writeRecord: async (...args) => writes.push(args), readRecord: async () => null, listRecords: async () => [], drain: async () => {} },
      readScope: async ({ sessionID, directory: projectDirectory }) => ({ session: { id: sessionID, directory: projectDirectory,
        ...(sessionID === 'ses_child' ? { parentID: 'ses_root' } : {}) }, projectIdentity: projectDirectory, projectDirectory }),
      readTaskState: async () => base, readMessage: async () => anchor, fingerprintFiles: async () => null,
      readChildAssignment: async ({ sessionID, maxBytes }) => {
        expect(maxBytes).toBeGreaterThan(10 * 1024);
        expect(maxBytes).toBeLessThan(12 * 1024);
        return sessionID === 'ses_child' ? 'Continue only the original delegated assignment below.\n{"taskId":"dvr_task_active"}' : null;
      },
      readPlanOutline: async () => ({ path: '/plans/plan.md', outline: '# Plan' }),
    });
    try {
      const root = await runtime.compactionAnchor({ sessionID: 'ses_root', directory: '/project' });
      expect(root).toMatchObject({ available: true, kind: 'root' });
      expect(root.text).toContain('File: /plans/plan.md');
      const child = await runtime.compactionAnchor({ sessionID: 'ses_child', directory: '/project' });
      expect(child).toMatchObject({ available: true, kind: 'child' });
      expect(child.text).toContain('## Delegated assignment');
      expect(child.text).toContain('"taskId":"dvr_task_active"');
      expect(writes).toEqual([]);
    } finally { await runtime.drain(); await fs.rm(directory, { recursive: true, force: true }); }
  });
});

test('final constructor authorization runs after canonical context reads and before record commits', async () => {
  let revoked=false,writes=0;
  const store={drain:async()=>{},directory:'/owned',readRecord:async()=>null,listRecords:async()=>[],writeRecord:async()=>{writes++;},deleteRecord:async()=>{throw Error('no pruning');}};
  const runtime=createTaskContextRuntime({dataDirectory:'/owned',store,withLock:async(_key,action)=>action(),
    readScope:async()=>({session:base.session,projectDirectory:'/project',projectIdentity:'/project'}),
    readTaskState:async()=>{revoked=true;return base;},readMessage:async()=>{revoked=true;return anchor;},fingerprintFiles:async()=>null,
    authorizeWrite:async()=>{if(revoked)throw Error('revoked_after_read');}});
  await expect(runtime.checkpoint({sessionID:'ses_root',directory:'/project'})).rejects.toThrow('revoked_after_read');
  revoked=false;
  await expect(runtime.rememberDecision({sessionID:'ses_root',directory:'/project',statement:'Keep dependencies unchanged.',sourceMessageID:'msg_user'})).rejects.toThrow('revoked_after_read');
  expect(writes).toBe(0);await runtime.drain();
});

const checkpointDeferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const checkpointFixture = (overrides = {}) => createTaskContextRuntime({ dataDirectory: '/owned',
  store: { directory: '/owned', drain: async () => {}, readRecord: async () => null,
    listRecords: async () => [], writeRecord: async () => {} },
  readScope: async () => ({ session: base.session, projectDirectory: '/project', projectIdentity: '/project' }),
  readTaskState: async () => base, fingerprintFiles: async () => null, ...overrides,
});

test('concurrent checkpoints rank decisions for each query rather than sharing the first ranked result', async () => {
  const gate = checkpointDeferred(), readsStarted = checkpointDeferred();
  let reads = 0;
  const decisions = Array.from({ length: 10 }, (_, index) => ({ id: `decision_${index}`, state: 'active', paths: [],
    createdAt: index, statement: index === 0 ? 'Preserve zebra routing.' : index === 1 ? 'Preserve otter routing.' : 'Unrelated choice.' }));
  const runtime = checkpointFixture({
    store: { directory: '/owned', drain: async () => {}, readRecord: async () => ({ decisions }), listRecords: async () => [], writeRecord: async () => {} },
    readTaskState: async () => { if (++reads === 2) readsStarted.resolve(); await gate.promise; return base; },
  });
  const left = runtime.checkpoint({ sessionID: 'ses_root', directory: '/project', query: 'zebra' });
  const right = runtime.checkpoint({ sessionID: 'ses_root', directory: '/project', query: 'otter' });
  await readsStarted.promise;
  gate.resolve();
  const results = await Promise.all([left, right]);
  expect(results[0].checkpoint.decisions[0].id).toBe('decision_0');
  expect(results[1].checkpoint.decisions[0].id).toBe('decision_1');
  expect(results[0].checkpoint.decisions.map(entry => entry.id)).not.toContain('decision_1');
  expect(results[1].checkpoint.decisions.map(entry => entry.id)).not.toContain('decision_0');
  await runtime.drain();
});

test('same-query checkpoints share canonical reads but reauthorize each caller before committing', async () => {
  const context = new AsyncLocalStorage(), gate = checkpointDeferred(), started = checkpointDeferred();
  const authorizations = [], writes = [];
  let reads = 0;
  const runtime = checkpointFixture({
    store: { directory: '/owned', drain: async () => {}, readRecord: async () => null, listRecords: async () => [],
      writeRecord: async () => { writes.push(context.getStore()); } },
    readTaskState: async () => { reads++; started.resolve(); await gate.promise; return base; },
    authorizeWrite: async () => { authorizations.push(context.getStore()); if (context.getStore() === 'revoked') throw Error('caller_revoked'); },
  });
  const first = context.run('authorized', () => runtime.checkpoint({ sessionID: 'ses_root', directory: '/project', query: 'same' }));
  await started.promise;
  const second = context.run('revoked', () => runtime.checkpoint({ sessionID: 'ses_root', directory: '/project', query: 'same' }));
  const failed = second.catch(error => error);
  await Promise.resolve(); await Promise.resolve();
  gate.resolve();
  await first;
  expect(await failed).toMatchObject({ message: 'caller_revoked' });
  expect(reads).toBe(1);
  expect(authorizations).toEqual(['authorized', 'revoked']);
  expect(writes).toEqual(['authorized']);
  await runtime.drain();
});

test('a checkpoint rejects a changed canonical scope after its shared read', async () => {
  let identity = '/project', writes = 0;
  const runtime = checkpointFixture({
    readScope: async () => ({ session: base.session, projectDirectory: '/project', projectIdentity: identity }),
    readTaskState: async () => { identity = '/replacement'; return base; },
    store: { directory: '/owned', drain: async () => {}, readRecord: async () => null, listRecords: async () => [], writeRecord: async () => { writes++; } },
  });
  await expect(runtime.checkpoint({ sessionID: 'ses_root', directory: '/project' })).rejects.toThrow('context_scope_changed');
  expect(writes).toBe(0);
  await runtime.drain();
});
