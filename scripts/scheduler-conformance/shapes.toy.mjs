// Ways a test awaits a member of the real scheduler, recorded and replayed by
// the replayer's self-test (replay.test.mjs), which checks the mark the
// recorder gives each probe call (`getTask` with the shape's name) and that
// planted copies end `different` here: a flush that settles one, two or three
// microtasks later (a case whose compared prefix has inputs placed in a
// settlement's continuation), and a port's already-settled promise delivered
// anywhere but at the port's return (two schedulers initializing at once).
// The last three reach code no scenario reaches (O0c review 2, the escaped
// plants): an initialize after shutdown, a publication that fails, a mutation
// that fails with its timing reported. O0c review 3 adds the case the planted
// replayers that deliver a `settle` input early or late are judged on (S1), and
// its fake-timer probe (B1).
// Named *.toy.mjs so that no suite discovers it; it touches nothing outside
// the schedulers it builds, and nothing here depends on how long anything takes.
import { expect, jest, test } from 'bun:test';
import { createManagedTaskScheduler } from '../../packages/orchestration-runtime/scheduler.js';

const make = (extra = {}) => createManagedTaskScheduler({
  now: () => 1_000,
  persistence: { load: async () => null, save: async () => {} },
  executor: { start: async () => ({ status: 'completed' }) },
  ...extra,
});
const probe = (scheduler, shape) => scheduler.getTask(`dvr_task_${shape}`);
const input = {
  idempotencyKey: 'shapes-task', rootSessionId: 'ses_root', parentTaskId: null, directory: '/workspace', mode: 'orchestrator',
  providerId: 'github-copilot', modelId: 'gpt-4.1', agent: 'explorer', variant: null, label: 'Shapes task', prompt: 'Probe the marks.', timeoutAt: null,
};

test('awaited directly', async () => {
  const s = make();
  await s.initialize();
  expect(probe(s, 'direct')).toBe(null);
});

test('awaited again once settled', async () => {
  const s = make();
  await s.initialize();
  await s.initialize();
  expect(probe(s, 'again')).toBe(null);
});

// The review's sweep (O0c review 2, B1'): the call k microtasks after a kept promise, before it is awaited.
for (const k of [0, 1, 2, 3, 19]) {
  test(`kept, ${k} microtasks, then a call`, async () => {
    const s = make();
    await s.initialize();
    const kept = s.flush();
    for (let i = 0; i < k; i += 1) await null;
    expect(probe(s, `kept${k}`)).toBe(null);
    await kept;
  });
}

test('kept, then awaited before it settles', async () => {
  const s = make();
  await s.initialize();
  const kept = s.flush();
  await kept;
  expect(probe(s, 'awaited')).toBe(null);
});

// Where the replay delivers an input placed in a settlement's continuation (O0c review 3, S1): replay-mutants.mjs
// replays this case against a copy whose flush changes a state getTask reads in the jobs right after its
// settlement (silently, in the job before the continuation and in the two after it); delivered one microtask early,
// one late or two late, the probe reads another state.
test('awaited, then a call the settlement\'s own continuation makes', async () => {
  const s = make();
  await s.initialize();
  await s.flush();
  expect(probe(s, 'delivery')).toBe(null);
});

// The third review's probe (B1): under fake timers a test timer's callback runs inside advanceTimersByTime, while the
// flush still has jobs queued; it is no rest point, so the probe is busy (it was placed rest, and replayed different).
test('a fake timer fires while a flush is under way', async () => {
  const s = make();
  await s.initialize();
  jest.useFakeTimers();
  try {
    const kept = s.flush();
    await null;
    setTimeout(() => { probe(s, 'fake'); }, 10);
    jest.advanceTimersByTime(20);
    await kept;
  } finally { jest.useRealTimers(); }
});

test('through a function that awaits it', async () => {
  const s = make();
  await s.initialize();
  const wrapper = async () => { await s.flush(); return probe(s, 'wrapped'); };
  expect(await wrapper()).toBe(null);
  expect(probe(s, 'after-wrapper')).toBe(null);
});

test('in a then, and in the then of that then', async () => {
  const s = make();
  await s.initialize();
  await s.flush().then(() => probe(s, 'then')).then(() => probe(s, 'then-then'));
});

test('two members under Promise.all', async () => {
  const s = make();
  await s.initialize();
  await Promise.all([s.flush(), s.flush()]);
  expect(probe(s, 'all')).toBe(null);
});

// A flush running beside another scheduler's initialization: its settlement falls among the other's events, after
// an input placed in a settlement's continuation (the flush itself, after the first initialization). A flush that
// settles later moves its settlement among them.
test('a flush beside another scheduler\'s initialization', async () => {
  const first = make();
  const second = make();
  await first.initialize();
  await Promise.all([first.flush(), second.initialize()]);
  probe(first, 'beside');
  expect((await first.submit(input)).taskId.startsWith('dvr_task_')).toBe(true);
  await first.shutdown();
});

// Two schedulers whose loads answer with promises already settled: each settlement is placed at its port's
// return, and the two initializations interleave; delivered anywhere else, the first would run alone.
test('two schedulers initialize at once', async () => {
  const first = make();
  const second = make();
  await Promise.all([first.initialize(), second.initialize()]);
  expect([probe(first, 'first'), probe(second, 'second')]).toEqual([null, null]);
});

test('initialize after shutdown is refused', async () => {
  const s = make();
  await s.shutdown();
  const refused = await s.initialize().catch((error) => error);
  expect(refused.code).toBe('scheduler_shut_down');
});

test('a publication that fails is logged', async () => {
  const warned = [];
  const s = make({ publishEvent: () => { throw new Error('publication refused'); }, logger: { warn: (message) => { warned.push(message); } } });
  await s.initialize();
  await s.submit(input);
  expect(warned.length > 0).toBe(true);
});

test('a mutation that fails reports its timing', async () => {
  const timings = [];
  const s = make({ persistence: { load: async () => null, save: async () => { throw new Error('save refused'); } }, onMutationTiming: (row) => { timings.push(row.failed); } });
  await s.initialize().catch(() => undefined);
  expect(timings.includes(true)).toBe(true);
});
