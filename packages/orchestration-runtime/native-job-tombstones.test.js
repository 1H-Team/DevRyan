import { describe, expect, test } from 'bun:test';
import { createManagedTaskScheduler } from './scheduler.js';
import {
  DEFAULT_MANAGED_TERMINAL_MAX_RECORDS,
  MANAGED_NATIVE_JOB_TOMBSTONE_PROMPT,
  compactManagedOrchestrationState,
  isManagedNativeJobTombstone,
} from './persistence.js';
import { createManagedTaskRecord } from './contract.js';
import { createLineageId } from './auto-resume-policy.js';
import { createManagedTaskResultEnvelope } from './result-envelope.js';
import { decodeLedgerSnapshot } from './codec.js';
import {
  MANAGED_NATIVE_JOB_PROOF_SHARDS,
  MANAGED_NATIVE_JOB_PROOF_SHARD_COUNT,
  decodeManagedNativeJobProofShard,
  encodeManagedNativeJobProofShard,
  managedNativeJobProofShard,
  managedNativeJobProofShardFile,
} from './native-job-proof-store.js';

const DAY = 24 * 60 * 60 * 1_000;
const EMPTY_LEDGER_BYTES = JSON.stringify({ version: 1, tasks: [], resultEnvelopes: [] }).length;

// A failed native attempt whose done receipt is the restart no-replay proof.
const proof = (index, { status = 'failed', completion = 'done', action = 'abandon', root = 'ses_root', finishedAt = 2, ...overrides } = {}) => {
  const task = {
    ...createManagedTaskRecord({ idempotencyKey: `native-${index}`, rootSessionId: root, parentTaskId: null, directory: '/workspace',
      mode: 'orchestrator', providerId: 'openai', modelId: 'fixture', agent: 'fixer', variant: 'high', label: `Native ${index}`,
      prompt: `Fix the native defect ${index}. ${'Context. '.repeat(512)}`, taskId: `dvr_task_native_${index}`, sequence: index + 1,
      createdAt: 1, timeoutAt: null, attempt: 1, priorTaskId: null, executionKind: 'start', executionBackend: 'native-job',
      dispatchGroupId: 'group', dispatchCallId: `call_${index}` }),
    childSessionId: `ses_child_${index}`, leaseToken: `dvr_lease_${index}`, status, startedAt: 1, finishedAt,
    failureReason: status === 'completed' ? null : 'The provider stream failed', partial: true,
    recoverablePreview: `Partial output ${index}. ${'Detail. '.repeat(256)}`,
    canonicalRefs: [{ type: 'message', id: `msg_child_assistant_${index}` }],
    nativeJobSegments: [{ jobID: `dvr_job_${index}`, notificationID: `msg_notification_${index}`, messageID: `msg_prompt_${index}`,
      state: 'accepted', completion }],
    ...overrides,
  };
  const envelope = { ...createManagedTaskResultEnvelope(task, { sequence: index + 1, createdAt: finishedAt, resumable: true }),
    action, acknowledgedAt: action === null ? null : finishedAt };
  return { task, envelope };
};
const ledger = proofs => ({ version: 1, tasks: proofs.map(entry => entry.task), resultEnvelopes: proofs.map(entry => entry.envelope) });
const retained = task => ({ taskId: task.taskId, leaseToken: task.leaseToken, rootSessionId: task.rootSessionId, directory: task.directory,
  childSessionId: task.childSessionId, providerId: task.providerId, modelId: task.modelId, agent: task.agent, variant: task.variant,
  executionBackend: task.executionBackend, status: task.status, idempotencyKey: task.idempotencyKey, nativeJobSegments: task.nativeJobSegments });
const memoryPersistence = state => {
  const store = { state, saves: 0 };
  return { store, persistence: { load: async () => store.state, save: async next => { store.state = structuredClone(next); store.saves += 1; } } };
};
const completingExecutor = { async start(_task, control) {
  await control.setChildSessionId('ses_new_child'); await control.markAccepted();
  return { status: 'completed', recoverablePreview: 'Done.' };
} };
const until = async predicate => {
  for (let attempt = 0; attempt < 200; attempt += 1) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 0)); }
  throw new Error('Expected condition did not arrive');
};

describe('retained native job proof tombstones', () => {
  test('retention shrinks an adverse proof into a valid body-free tombstone that no cap counts', () => {
    const entry = proof(0);
    const compacted = compactManagedOrchestrationState(ledger([entry]),
      { now: 1_000, maxAgeMs: 1, maxTerminalRecords: 0, maxBytes: EMPTY_LEDGER_BYTES });
    expect(compacted).toMatchObject({ removedTaskIds: [], tombstonedTaskIds: [entry.task.taskId], overLimit: false });
    const [task] = compacted.state.tasks, [envelope] = compacted.state.resultEnvelopes;
    expect(task).toMatchObject({ ...retained(entry.task), prompt: MANAGED_NATIVE_JOB_TOMBSTONE_PROMPT, recoverablePreview: '',
      failureReason: null, canonicalRefs: [], dispatchGroupId: null, dispatchCallId: null, dispatchWaveId: null, transportRecovery: null });
    expect(isManagedNativeJobTombstone(task)).toBe(true);
    expect(envelope).toMatchObject({ envelopeId: entry.envelope.envelopeId, taskId: task.taskId, action: 'abandon', status: 'failed',
      recoverablePreview: '', failureReason: null, canonicalRefs: [] });
    expect(JSON.stringify(compacted.state)).not.toContain('Context.');
    expect(JSON.stringify(compacted.state)).not.toContain('Detail.');
    expect(compacted.serializedBytes).toBe(JSON.stringify(compacted.state).length);
    expect(compacted.serializedBytes).toBeLessThan(JSON.stringify(ledger([entry])).length / 4);
    expect(decodeLedgerSnapshot(compacted.state).tasks).toHaveLength(1);
    // A second pass neither rewrites nor counts the tombstone.
    const again = compactManagedOrchestrationState(compacted.state,
      { now: 1_000, maxAgeMs: 1, maxTerminalRecords: 0, maxBytes: EMPTY_LEDGER_BYTES });
    expect(again).toMatchObject({ removedTaskIds: [], tombstonedTaskIds: [], overLimit: false });
    expect(again.state).toEqual(compacted.state);
  });

  test.each([
    ['age', { now: 20 * DAY }],
    ['count', { now: 3, maxTerminalRecords: 1 }],
    ['bytes', { now: 3 }],
  ])('%s retention tombstones the oldest proof where it would remove ordinary history', (name, options) => {
    const entries = [0, 1].map(index => proof(index, { finishedAt: 2 + index }));
    const bytes = name === 'bytes' ? { maxBytes: JSON.stringify(ledger(entries)).length - 1 } : {};
    const compacted = compactManagedOrchestrationState(ledger(entries), { ...options, ...bytes });
    expect(compacted.removedTaskIds).toEqual([]);
    expect(compacted.tombstonedTaskIds).toContain(entries[0].task.taskId);
    expect(compacted.state.tasks).toHaveLength(2);
    expect(compacted.overLimit).toBe(false);
    expect(compacted.state.tasks.map(task => retained(task))).toEqual(entries.map(entry => retained(entry.task)));
  });

  test('eager lineage bounds tombstone acknowledged proofs and stop counting them', () => {
    const lineage = createLineageId('dvr_task_native_0');
    const entries = [];
    for (let index = 0; index < 5; index += 1) entries.push(proof(index, { finishedAt: 2 + index, ...(index ? {
      recoveryLineageId: lineage, priorTaskId: entries[index - 1].task.taskId, attempt: index + 1, executionKind: 'retry' } : {}) }));
    const first = compactManagedOrchestrationState(ledger(entries), { now: 10 });
    expect(first.removedTaskIds).toEqual([]);
    expect(first.tombstonedTaskIds).toEqual(entries.slice(0, 2).map(entry => entry.task.taskId));
    expect(compactManagedOrchestrationState(first.state, { now: 10 }).tombstonedTaskIds).toEqual([]);
  });

  test('a proof ordinary retention still keeps stays whole, and protected whole work still reports pressure', () => {
    const quiet = proof(0, { finishedAt: 2 });
    expect(compactManagedOrchestrationState(ledger([quiet]), { now: 3 }).state.tasks[0].prompt).toBe(quiet.task.prompt);
    // An unacknowledged grouped result in an active conversation is not history yet.
    const parked = proof(1, { action: null, finishedAt: 2 });
    const compacted = compactManagedOrchestrationState(ledger([parked]), { now: 3, maxTerminalRecords: 0 });
    expect(compacted).toMatchObject({ tombstonedTaskIds: [], removedTaskIds: [], overLimit: true });
    expect(compacted.state.tasks[0].prompt).toBe(parked.task.prompt);
  });

  test('2,001 retained proofs never refuse a submit and keep every input disposition', async () => {
    const entries = Array.from({ length: DEFAULT_MANAGED_TERMINAL_MAX_RECORDS + 1 }, (_value, index) => proof(index, { finishedAt: 2 + index }));
    const { store, persistence } = memoryPersistence(ledger(entries));
    const scheduler = createManagedTaskScheduler({ now: () => 2 * DAY, persistence, executor: completingExecutor });
    try {
      const dispositions = await scheduler.readNativeJobInputDispositions();
      expect(dispositions).toHaveLength(entries.length);
      expect(dispositions.map(row => row.envelopeID)).toEqual(entries.map(entry => entry.envelope.envelopeId));
      expect(store.state.tasks.filter(isManagedNativeJobTombstone)).toHaveLength(1);
      // In-memory state matches the saved tombstone.
      expect(scheduler.getTask(entries[0].task.taskId).prompt).toBe(MANAGED_NATIVE_JOB_TOMBSTONE_PROMPT);
      expect(scheduler.getTask(entries[1].task.taskId).prompt).toBe(entries[1].task.prompt);
      const submitted = await scheduler.submit({ idempotencyKey: 'after-proofs', rootSessionId: 'ses_root', parentTaskId: null,
        directory: '/workspace', mode: 'orchestrator', providerId: 'openai', modelId: 'fixture', agent: 'explorer', variant: null,
        label: 'After proofs', prompt: 'Inspect.', timeoutAt: null });
      expect(submitted.taskId).toMatch(/^dvr_task_/);
      await until(() => scheduler.getTask(submitted.taskId)?.status === 'completed');
      expect(store.state.tasks.filter(isManagedNativeJobTombstone).length).toBeGreaterThanOrEqual(2);
      expect(await scheduler.readNativeJobInputDispositions()).toHaveLength(entries.length);
    } finally { await scheduler.shutdown(); }
  }, 60_000);

  test('a loaded ledger of 2,001 tombstones admits new work', async () => {
    const entries = Array.from({ length: DEFAULT_MANAGED_TERMINAL_MAX_RECORDS + 1 }, (_value, index) => proof(index));
    const tombstoned = compactManagedOrchestrationState(ledger(entries), { now: 20 * DAY }).state;
    expect(tombstoned.tasks.every(isManagedNativeJobTombstone)).toBe(true);
    const { store, persistence } = memoryPersistence(tombstoned);
    const scheduler = createManagedTaskScheduler({ now: () => 20 * DAY, persistence, executor: completingExecutor });
    try {
      const submitted = await scheduler.submit({ idempotencyKey: 'after-tombstones', rootSessionId: 'ses_other', parentTaskId: null,
        directory: '/workspace', mode: 'orchestrator', providerId: 'openai', modelId: 'fixture', agent: 'explorer', variant: null,
        label: 'After tombstones', prompt: 'Inspect.', timeoutAt: null });
      await until(() => scheduler.getTask(submitted.taskId)?.status === 'completed');
      expect(store.state.tasks).toHaveLength(entries.length + 1);
      expect(await scheduler.readNativeJobInputDispositions()).toHaveLength(entries.length);
    } finally { await scheduler.shutdown(); }
  }, 60_000);

  test('a tombstone with a pending receipt still acknowledges with its exact identities', async () => {
    const adverse = proof(0, { completion: 'pending' }), completed = proof(1, { status: 'completed', completion: 'pending' });
    const calls = [];
    const { store, persistence } = memoryPersistence(ledger([adverse, completed]));
    const scheduler = createManagedTaskScheduler({ now: () => 20 * DAY, persistence, executor: completingExecutor,
      acknowledgeNativeJob: async ({ task, segment, envelopeID }) => { calls.push({ ...retained(task), prompt: task.prompt, segment, envelopeID }); } });
    try {
      await scheduler.initialize();
      // The adverse receipt stays a proof; the completed one is ordinary aged history again and compacts.
      await until(() => calls.length === 2 && scheduler.getTask(adverse.task.taskId)?.nativeJobSegments[0].completion === 'done'
        && scheduler.getTask(completed.task.taskId) === null);
      expect(calls).toEqual([adverse, completed].map(entry => ({ ...retained(entry.task), prompt: MANAGED_NATIVE_JOB_TOMBSTONE_PROMPT,
        segment: entry.task.nativeJobSegments[0], envelopeID: entry.envelope.envelopeId })));
      expect(isManagedNativeJobTombstone(scheduler.getTask(adverse.task.taskId))).toBe(true);
      expect(scheduler.getTask(completed.task.taskId)).toBeNull();
      expect(store.state.tasks.some(task => task.taskId === completed.task.taskId)).toBe(false);
    } finally { await scheduler.shutdown(); }
  });

  test('a released tombstone refuses follow-ups that need its prompt and still allows collection', async () => {
    const entry = proof(0, { action: null, dispatchGroupId: null });
    const { persistence } = memoryPersistence(ledger([entry]));
    const scheduler = createManagedTaskScheduler({ now: () => 20 * DAY, persistence, executor: completingExecutor });
    try {
      await scheduler.initialize();
      expect(isManagedNativeJobTombstone(scheduler.getTask(entry.task.taskId))).toBe(true);
      for (const action of ['retry', 'resume', 'retry_in_place']) {
        await expect(scheduler.acknowledgeResult(entry.task.taskId, { action, idempotencyKey: `follow-up-${action}` }))
          .rejects.toMatchObject({ code: 'result_not_found' });
      }
      const collected = await scheduler.acknowledgeResult(entry.task.taskId, { action: 'collect', idempotencyKey: 'collect' });
      expect(collected.envelope).toMatchObject({ action: 'collect', recoverablePreview: '', envelopeId: entry.envelope.envelopeId });
      expect(collected.followUpTask).toBeNull();
    } finally { await scheduler.shutdown(); }
  });

  test('deleting every session releases tombstones only through verified disposal, and startup resolves afterwards', async () => {
    const entries = [0, 1, 2, 3].map(index => proof(index, { root: index < 2 ? 'ses_root_a' : 'ses_root_b' }));
    const { store, persistence } = memoryPersistence(ledger(entries));
    const first = createManagedTaskScheduler({ now: () => 20 * DAY, persistence, executor: completingExecutor });
    try {
      await first.initialize();
      expect(store.state.tasks.every(isManagedNativeJobTombstone)).toBe(true);
      // Startup with every session gone but no verified disposal keeps every proof.
      expect(await first.readNativeJobInputDispositions()).toHaveLength(4);
      for (const root of ['ses_root_a', 'ses_root_b']) {
        const sessions = [root, ...entries.filter(entry => entry.task.rootSessionId === root).map(entry => entry.task.childSessionId)];
        await first.discardObjectiveChecks({ directory: '/workspace', sessions }, async () => {});
      }
      expect(store.state.tasks).toEqual([]);
      expect(await first.readNativeJobInputDispositions()).toEqual([]);
    } finally { await first.shutdown(); }
    const restarted = createManagedTaskScheduler({ now: () => 20 * DAY, persistence, executor: completingExecutor });
    try {
      await restarted.initialize();
      expect(await restarted.readNativeJobInputDispositions()).toEqual([]);
      expect(restarted.getSnapshot().tasks).toEqual([]);
    } finally { await restarted.shutdown(); }
  });
});

// A persistence with proof shards, as the web ledger exposes them. `log`
// records the commit order; `failShard` / `failSave` inject a crash point.
const shardedPersistence = (state, { shards = new Map() } = {}) => {
  const store = { state, shards, log: [], failShard: null, failSave: false, saved: [] };
  const persistence = {
    load: async () => store.state,
    save: async (next) => {
      store.log.push('save');
      if (store.failSave) throw Object.assign(new Error('fixture ledger write failed'), { code: 'fixture_save_failed' });
      store.state = structuredClone(next); store.saved.push(JSON.stringify(next).length);
    },
    loadNativeJobProofShards: async () => [...store.shards].map(([shard, text]) => ({ shard, value: JSON.parse(text) })),
    putNativeJobProofShard: async (shard, text) => {
      store.log.push(`put:${shard}`);
      if (store.failShard === '*' || store.failShard === shard) throw Object.assign(new Error('fixture shard write failed'), { code: 'fixture_shard_failed' });
      store.shards.set(shard, text);
    },
    removeNativeJobProofShard: async (shard) => { store.log.push(`remove:${shard}`); store.shards.delete(shard); },
  };
  return { store, persistence };
};
const shardedProofs = store => [...store.shards].flatMap(([shard, text]) => decodeManagedNativeJobProofShard(JSON.parse(text), shard));
const submitInput = (key, root = 'ses_other') => ({ idempotencyKey: key, rootSessionId: root, parentTaskId: null, directory: '/workspace',
  mode: 'orchestrator', providerId: 'openai', modelId: 'fixture', agent: 'explorer', variant: null, label: key, prompt: 'Inspect.', timeoutAt: null });

describe('native job proof shards', () => {
  test('the shard function is stable, covers every shard, and names fixed files', () => {
    expect(MANAGED_NATIVE_JOB_PROOF_SHARDS).toHaveLength(MANAGED_NATIVE_JOB_PROOF_SHARD_COUNT);
    expect(MANAGED_NATIVE_JOB_PROOF_SHARD_COUNT).toBeGreaterThanOrEqual(64);
    expect(managedNativeJobProofShard('dvr_task_native_0')).toBe(managedNativeJobProofShard('dvr_task_native_0'));
    const counts = new Map();
    for (let index = 0; index < 10_000; index += 1) {
      const shard = managedNativeJobProofShard(`dvr_task_${index.toString(16).padStart(32, '0')}`);
      counts.set(shard, (counts.get(shard) ?? 0) + 1);
    }
    expect([...counts.keys()].sort()).toEqual([...MANAGED_NATIVE_JOB_PROOF_SHARDS]);
    expect(Math.max(...counts.values())).toBeLessThan(2 * 10_000 / MANAGED_NATIVE_JOB_PROOF_SHARD_COUNT);
    expect(managedNativeJobProofShardFile('3f')).toBe('3f.json');
    for (const name of ['40', '../00', '0A', '', null]) expect(() => managedNativeJobProofShardFile(name)).toThrow();
  });

  test('a shard decodes whole or refuses: wrong shard, live record, missing envelope or unknown key', () => {
    const tombstoned = compactManagedOrchestrationState(ledger([proof(0)]), { now: 20 * DAY }).state;
    const [task] = tombstoned.tasks, [envelope] = tombstoned.resultEnvelopes, shard = managedNativeJobProofShard(task.taskId);
    const text = encodeManagedNativeJobProofShard(shard, [{ task, envelope }]);
    expect(decodeManagedNativeJobProofShard(JSON.parse(text), shard)).toEqual([{ task, envelope }]);
    const other = MANAGED_NATIVE_JOB_PROOF_SHARDS.find(name => name !== shard);
    expect(() => encodeManagedNativeJobProofShard(other, [{ task, envelope }])).toThrow();
    const live = proof(1);
    for (const [value, name] of [
      [{ ...JSON.parse(text), shard: other }, other],
      [JSON.parse(text), other],
      [{ ...JSON.parse(text), resultEnvelopes: [] }, shard],
      [{ ...JSON.parse(text), extra: true }, shard],
      [{ version: 1, shard: managedNativeJobProofShard(live.task.taskId), tasks: [live.task], resultEnvelopes: [live.envelope] }, managedNativeJobProofShard(live.task.taskId)],
      [{ ...JSON.parse(text), tasks: [{ ...task, nativeJobSegments: [{ ...task.nativeJobSegments[0], state: 'bogus' }] }] }, shard],
    ]) expect(() => decodeManagedNativeJobProofShard(value, name)).toThrow(expect.objectContaining({ code: 'native_job_proof_shard_invalid' }));
  });

  test('released proofs leave the main ledger shard-first; commits afterwards never serialize or rewrite them', async () => {
    const entries = Array.from({ length: DEFAULT_MANAGED_TERMINAL_MAX_RECORDS + 1 }, (_value, index) => proof(index));
    const { store, persistence } = shardedPersistence(ledger(entries));
    const scheduler = createManagedTaskScheduler({ now: () => 20 * DAY, persistence, executor: completingExecutor });
    try {
      const dispositions = await scheduler.readNativeJobInputDispositions();
      expect(dispositions).toHaveLength(entries.length);
      // Every shard write precedes the commit that dropped the full records.
      expect(store.log.indexOf('save')).toBeGreaterThan(store.log.findLastIndex(entry => entry.startsWith('put:')));
      expect(store.state.tasks).toEqual([]);
      expect(store.state.resultEnvelopes).toEqual([]);
      const proofs = shardedProofs(store);
      expect(proofs.map(entry => entry.task.taskId).sort()).toEqual(entries.map(entry => entry.task.taskId).sort());
      expect(proofs.every(entry => isManagedNativeJobTombstone(entry.task))).toBe(true);
      expect(new Set(proofs.map(entry => managedNativeJobProofShard(entry.task.taskId))).size).toBe(store.shards.size);
      // Point reads resolve proofs; listings and snapshots treat them as released history.
      expect(scheduler.getTask(entries[0].task.taskId)).toMatchObject({ ...retained(entries[0].task), prompt: MANAGED_NATIVE_JOB_TOMBSTONE_PROMPT });
      expect(scheduler.getResultEnvelope(entries[0].task.taskId)).toMatchObject({ envelopeId: entries[0].envelope.envelopeId });
      expect(scheduler.listTasks()).toEqual([]);
      expect(scheduler.getDiagnostics()).toMatchObject({ nativeJobProofCount: entries.length, pendingNativeJobProofShardCount: 0 });
      store.log.length = 0;
      const submitted = await scheduler.submit(submitInput('after-proofs'));
      await until(() => scheduler.getTask(submitted.taskId)?.status === 'completed');
      await scheduler.flush();
      expect(store.log.every(entry => entry === 'save')).toBe(true);
      expect(Math.max(...store.saved.slice(-store.log.length))).toBeLessThan(16 * 1024);
      expect(store.state.tasks.map(task => task.taskId)).toEqual([submitted.taskId]);
      // An idempotent resubmit of a released proof still resolves to it.
      expect((await scheduler.submit({ ...submitInput(entries[1].task.idempotencyKey, 'ses_root') })).taskId).toBe(entries[1].task.taskId);
    } finally { await scheduler.shutdown(); }
    const restarted = createManagedTaskScheduler({ now: () => 20 * DAY, persistence, executor: completingExecutor });
    try {
      const dispositions = await restarted.readNativeJobInputDispositions();
      expect(dispositions.map(row => row.envelopeID).sort()).toEqual(entries.map(entry => entry.envelope.envelopeId).sort());
      expect(dispositions.find(row => row.taskId === entries[2].task.taskId)).toMatchObject({ leaseToken: entries[2].task.leaseToken,
        sessionID: entries[2].task.childSessionId, messageID: entries[2].task.nativeJobSegments[0].messageID });
    } finally { await restarted.shutdown(); }
  }, 60_000);

  test('a crash between the shard write and the ledger commit resolves to the ledger record and releases it again idempotently', async () => {
    const entries = [0, 1, 2].map(index => proof(index));
    const { store, persistence } = shardedPersistence(ledger(entries));
    store.failSave = true;
    const crashed = createManagedTaskScheduler({ now: () => 20 * DAY, persistence, executor: completingExecutor, logger: { warn() {} } });
    await expect(crashed.readNativeJobInputDispositions()).rejects.toMatchObject({ code: 'fixture_save_failed' });
    // The writer stays down through shutdown, so its final commit fails too.
    await expect(crashed.shutdown()).rejects.toMatchObject({ code: 'fixture_save_failed' });
    // Both stores now hold every task: the ledger's full record and the shard copy.
    expect(store.state.tasks.map(task => task.prompt)).toEqual(entries.map(entry => entry.task.prompt));
    expect(shardedProofs(store)).toHaveLength(3);
    const firstShards = new Map(store.shards);
    store.failSave = false; store.log.length = 0;
    // A ledger that still keeps the record whole wins over the stale copy.
    let clock = 3;
    const fresh = createManagedTaskScheduler({ now: () => clock, persistence, executor: completingExecutor });
    try {
      expect(await fresh.readNativeJobInputDispositions()).toHaveLength(3);
      expect(fresh.getTask(entries[0].task.taskId).prompt).toBe(entries[0].task.prompt);
      expect(fresh.listTasks()).toHaveLength(3);
      expect(store.state.tasks).toHaveLength(3);
      // Once retention releases them, the same shards are rewritten byte for byte.
      clock = 20 * DAY;
      await fresh.submit(submitInput('release'));
      await fresh.flush();
      expect(store.state.tasks.some(task => entries.some(entry => entry.task.taskId === task.taskId))).toBe(false);
      expect(store.shards).toEqual(firstShards);
      expect(await fresh.readNativeJobInputDispositions()).toHaveLength(3);
    } finally { await fresh.shutdown(); }
  });

  test('a shard that cannot take a proof keeps its tombstone inline until a later commit moves it', async () => {
    const entries = [0, 1].map(index => proof(index));
    const { store, persistence } = shardedPersistence(ledger(entries));
    store.failShard = '*';
    const warnings = [];
    const scheduler = createManagedTaskScheduler({ now: () => 20 * DAY, persistence, executor: completingExecutor,
      logger: { warn: (message, detail) => warnings.push([message, detail.code]) } });
    try {
      expect(await scheduler.readNativeJobInputDispositions()).toHaveLength(2);
      expect(store.state.tasks.map(task => isManagedNativeJobTombstone(task))).toEqual([true, true]);
      expect(JSON.stringify(store.state)).not.toContain('Context.');
      expect(warnings.some(([message, code]) => message.includes('stay in the ledger') && code === 'fixture_shard_failed')).toBe(true);
      store.failShard = null;
      const submitted = await scheduler.submit(submitInput('after-recovery'));
      await until(() => scheduler.getTask(submitted.taskId)?.status === 'completed');
      await scheduler.flush();
      expect(store.state.tasks.map(task => task.taskId)).toEqual([submitted.taskId]);
      expect(shardedProofs(store)).toHaveLength(2);
      expect(await scheduler.readNativeJobInputDispositions()).toHaveLength(2);
    } finally { await scheduler.shutdown(); }
  });

  test('verified disposal changes a shard only after the ledger commit that dispositions it', async () => {
    const entries = [0, 1, 2, 3].map(index => proof(index, { root: index < 2 ? 'ses_root_a' : 'ses_root_b' }));
    const { store, persistence } = shardedPersistence(ledger(entries));
    const scheduler = createManagedTaskScheduler({ now: () => 20 * DAY, persistence, executor: completingExecutor });
    const scope = root => ({ directory: '/workspace', sessions: [root, ...entries.filter(entry => entry.task.rootSessionId === root).map(entry => entry.task.childSessionId)] });
    try {
      await scheduler.initialize();
      expect(shardedProofs(store)).toHaveLength(4);
      // A failed ledger commit leaves every proof in its shard and in memory.
      store.failSave = true; store.log.length = 0;
      await expect(scheduler.discardObjectiveChecks(scope('ses_root_a'), async () => {})).rejects.toMatchObject({ code: 'fixture_save_failed' });
      expect(store.log).toEqual(['save']);
      expect(shardedProofs(store)).toHaveLength(4);
      expect(await scheduler.readNativeJobInputDispositions()).toHaveLength(4);
      store.failSave = false; store.log.length = 0;
      await scheduler.discardObjectiveChecks(scope('ses_root_a'), async () => {});
      expect(store.log[0]).toBe('save');
      expect(store.log.slice(1).every(entry => /^(put|remove):/.test(entry))).toBe(true);
      expect(shardedProofs(store).map(entry => entry.task.rootSessionId)).toEqual(['ses_root_b', 'ses_root_b']);
      expect(scheduler.getTask(entries[0].task.taskId)).toBeNull();
      await scheduler.discardObjectiveChecks(scope('ses_root_b'), async () => {});
      expect(store.shards.size).toBe(0);
      expect(await scheduler.readNativeJobInputDispositions()).toEqual([]);
    } finally { await scheduler.shutdown(); }
    const restarted = createManagedTaskScheduler({ now: () => 20 * DAY, persistence, executor: completingExecutor });
    try { expect(await restarted.readNativeJobInputDispositions()).toEqual([]); } finally { await restarted.shutdown(); }
  });

  test('a disposal whose commit fails keeps its proof even when that commit rewrote the shard for another release', async () => {
    const shardOf = index => managedNativeJobProofShard(`dvr_task_native_${index}`);
    const partner = Array.from({ length: 2_000 }, (_value, index) => index + 1).find(index => shardOf(index) === shardOf(0));
    const disposed = proof(0, { root: 'ses_root_a' }), later = proof(partner, { root: 'ses_root_b', finishedAt: 20 * DAY - 1 });
    const { store, persistence } = shardedPersistence(ledger([disposed, later]));
    let clock = 20 * DAY;
    const scheduler = createManagedTaskScheduler({ now: () => clock, persistence, executor: completingExecutor });
    try {
      await scheduler.initialize();
      expect(shardedProofs(store).map(entry => entry.task.taskId)).toEqual([disposed.task.taskId]);
      clock = 40 * DAY; store.failSave = true; store.log.length = 0;
      await expect(scheduler.discardObjectiveChecks({ directory: '/workspace', sessions: ['ses_root_a', disposed.task.childSessionId] }, async () => {}))
        .rejects.toMatchObject({ code: 'fixture_save_failed' });
      // The release of the other proof rewrote the shard first; it still holds the disposed one.
      expect(store.log).toEqual([`put:${shardOf(0)}`, 'save']);
      expect(shardedProofs(store).map(entry => entry.task.taskId).sort()).toEqual([disposed.task.taskId, later.task.taskId].sort());
      expect((await scheduler.readNativeJobInputDispositions()).map(row => row.taskId).sort()).toEqual([disposed.task.taskId, later.task.taskId].sort());
      store.failSave = false;
      await scheduler.discardObjectiveChecks({ directory: '/workspace', sessions: ['ses_root_a', disposed.task.childSessionId] }, async () => {});
      expect(shardedProofs(store).map(entry => entry.task.taskId)).toEqual([later.task.taskId]);
      expect(store.state.tasks).toEqual([]);
    } finally { await scheduler.shutdown(); }
  });

  test('a sharded proof with a pending receipt acknowledges with its exact identities and its shard records the receipt', async () => {
    const adverse = proof(0, { completion: 'pending' }), completed = proof(1, { status: 'completed', completion: 'pending' });
    const tombstoned = compactManagedOrchestrationState(ledger([adverse, completed]), { now: 20 * DAY }).state;
    const shards = new Map();
    for (const task of tombstoned.tasks) {
      const shard = managedNativeJobProofShard(task.taskId);
      shards.set(shard, encodeManagedNativeJobProofShard(shard, [...(shards.has(shard) ? decodeManagedNativeJobProofShard(JSON.parse(shards.get(shard)), shard) : []),
        { task, envelope: tombstoned.resultEnvelopes.find(envelope => envelope.taskId === task.taskId) }]));
    }
    const { store, persistence } = shardedPersistence(null, { shards });
    const calls = [], verified = [];
    let scheduler;
    scheduler = createManagedTaskScheduler({ now: () => 20 * DAY, persistence, executor: completingExecutor,
      acknowledgeNativeJob: async ({ task, segment, envelopeID }) => {
        verified.push(await scheduler.verifyNativeJobSegment({ phase: 'acknowledge', taskId: task.taskId, leaseToken: task.leaseToken,
          rootSessionId: task.rootSessionId, directory: task.directory, sessionID: task.childSessionId, providerId: task.providerId,
          modelId: task.modelId, agent: task.agent, variant: task.variant, ...segment, envelopeID }));
        calls.push({ ...retained(task), prompt: task.prompt, segment, envelopeID });
      } });
    try {
      await scheduler.initialize();
      await until(() => calls.length === 2 && shardedProofs(store).length === 1
        && shardedProofs(store)[0].task.nativeJobSegments[0].completion === 'done');
      expect(calls).toEqual([adverse, completed].map(entry => ({ ...retained(entry.task), prompt: MANAGED_NATIVE_JOB_TOMBSTONE_PROMPT,
        segment: entry.task.nativeJobSegments[0], envelopeID: entry.envelope.envelopeId })));
      expect(verified.map(row => row.task.taskId)).toEqual([adverse.task.taskId, completed.task.taskId]);
      expect(shardedProofs(store)[0].task.taskId).toBe(adverse.task.taskId);
      // The completed attempt is ordinary aged history once its receipt is done.
      expect(scheduler.getTask(completed.task.taskId)).toBeNull();
      expect(store.state.tasks).toEqual([]);
      expect(scheduler.listTasks()).toEqual([]);
    } finally { await scheduler.shutdown(); }
  });

  test('a sharded proof refuses follow-ups, still accepts collection, and records it in its shard', async () => {
    const entry = proof(0, { action: null, dispatchGroupId: null });
    const { store, persistence } = shardedPersistence(ledger([entry]));
    const scheduler = createManagedTaskScheduler({ now: () => 20 * DAY, persistence, executor: completingExecutor });
    try {
      await scheduler.initialize();
      expect(store.state.tasks).toEqual([]);
      for (const action of ['retry', 'resume', 'retry_in_place', 'recover_in_place']) {
        await expect(scheduler.acknowledgeResult(entry.task.taskId, { action, idempotencyKey: `follow-up-${action}` }))
          .rejects.toMatchObject({ code: 'result_not_found' });
      }
      const collected = await scheduler.acknowledgeResult(entry.task.taskId, { action: 'collect', idempotencyKey: 'collect' });
      expect(collected.envelope).toMatchObject({ action: 'collect', recoverablePreview: '', envelopeId: entry.envelope.envelopeId });
      expect(collected.followUpTask).toBeNull();
      expect(store.state.tasks).toEqual([]);
      expect(shardedProofs(store)[0].envelope.action).toBe('collect');
      // Repeating the same disposition answers from the shard; another is refused.
      expect((await scheduler.acknowledgeResult(entry.task.taskId, { action: 'collect', idempotencyKey: 'collect' })).envelope.action).toBe('collect');
      await expect(scheduler.acknowledgeResult(entry.task.taskId, { action: 'abandon', idempotencyKey: 'abandon' }))
        .rejects.toMatchObject({ code: 'result_already_acknowledged' });
    } finally { await scheduler.shutdown(); }
  });

  test('an invalid or unreadable shard refuses loading instead of forgetting its proofs', async () => {
    const shard = MANAGED_NATIVE_JOB_PROOF_SHARDS[5];
    const { persistence } = shardedPersistence(null, { shards: new Map([[shard, JSON.stringify({ version: 1, shard, tasks: [{}], resultEnvelopes: [] })]]) });
    const scheduler = createManagedTaskScheduler({ persistence, executor: completingExecutor, logger: { warn() {} } });
    await expect(scheduler.initialize()).rejects.toMatchObject({ code: 'invalid_native_job_proof_store' });
    await scheduler.shutdown();
    const unreadable = { ...persistence, loadNativeJobProofShards: async () => { throw Object.assign(new Error('unreadable'), { code: 'native_job_proof_shard_unreadable' }); } };
    const refused = createManagedTaskScheduler({ persistence: unreadable, executor: completingExecutor });
    await expect(refused.initialize()).rejects.toMatchObject({ code: 'native_job_proof_shard_unreadable' });
    await refused.shutdown();
  });
});
