import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { COMPACTION_ANCHOR_TAG, createTaskContextRuntime, deriveTaskCheckpoint, formatCompactionAnchor } from './task-context.js';

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

  test('shed the plan outline, then detail, before shortening the objective below its cap', () => {
    const long = structuredClone(anchor); long.parts[0].text = `${'objective '.repeat(1_500)}`;
    const todos = Array.from({ length: 20 }, (_, i) => ({ id: `todo_${i}`, content: 'x'.repeat(400), status: 'pending' }));
    const tasks = Array.from({ length: 40 }, (_, i) => ({ taskId: `dvr_task_${i}`, rootSessionId: 'ses_root', childSessionId: `ses_${i}`, status: 'running' }));
    const text = formatCompactionAnchor(deriveTaskCheckpoint({ ...base, anchor: long, todos, tasks, now: 0 }), { planPath: '/p.md', planOutline: '- step\n'.repeat(2_000) });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(12 * 1024);
    expect(text).toContain('truncated');
    expect(text).not.toContain('- step');
    expect(text).toContain('(more tasks outstanding)');
  });

  test('the runtime anchor writes no record and a managed child gets its assignment', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-anchor-'));
    const writes = [];
    const runtime = createTaskContextRuntime({ dataDirectory: directory,
      store: { writeRecord: async (...args) => writes.push(args), readRecord: async () => null, listRecords: async () => [], drain: async () => {} },
      readScope: async ({ sessionID, directory: projectDirectory }) => ({ session: { id: sessionID, directory: projectDirectory,
        ...(sessionID === 'ses_child' ? { parentID: 'ses_root' } : {}) }, projectIdentity: projectDirectory, projectDirectory }),
      readTaskState: async () => base, readMessage: async () => anchor, fingerprintFiles: async () => null,
      readChildAssignment: async ({ sessionID }) => sessionID === 'ses_child' ? 'Continue only the original delegated assignment below.\n{"taskId":"dvr_task_active"}' : null,
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
