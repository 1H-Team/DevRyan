import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  createCommandDeadlineController,
  validateCommandDeadlineRecord,
} from './command-deadline.js';

const clone = (value) => JSON.parse(JSON.stringify(value));

const createMemoryStore = (seed = []) => {
  const records = new Map(seed.map(({ key, record }) => [key, clone(record)]));
  return {
    records,
    async initialize() {},
    async listRecords() {
      return [...records].map(([key, record]) => ({ key, record: clone(record) }));
    },
    async writeRecord(key, record) {
      records.set(key, clone(record));
      return record;
    },
    async deleteRecord(key) {
      records.delete(key);
    },
    async drain() {},
  };
};

const createFakeClock = (initial = 1_000) => {
  let current = initial;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => current,
    set(value) {
      current = value;
    },
    setTimeout(callback, delay) {
      const timer = { id: ++sequence, at: current + delay, unref() {} };
      timers.set(timer.id, { timer, callback });
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timers.delete(timer.id);
    },
    async advance(milliseconds) {
      current += milliseconds;
      const ready = [...timers.values()]
        .filter(({ timer }) => timer.at <= current)
        .sort((left, right) => left.timer.at - right.timer.at);
      for (const task of ready) {
        timers.delete(task.timer.id);
        task.callback();
      }
      await Promise.resolve();
      await Promise.resolve();
    },
  };
};

const runningPart = (overrides = {}) => ({
  id: 'part_1',
  messageID: 'msg_1',
  sessionID: 'ses_1',
  type: 'tool',
  tool: 'bash',
  callID: 'call_1',
  state: {
    status: 'running',
    input: { command: 'secret mutating command', timeout: 1_000 },
    time: { start: 1_000 },
  },
  ...overrides,
});

const partEvent = (part = runningPart()) => ({
  type: 'message.part.updated',
  properties: {
    sessionID: part.sessionID,
    messageID: part.messageID,
    part,
  },
});

const message = (part = runningPart()) => ({
  info: { id: part.messageID, sessionID: part.sessionID, role: 'assistant' },
  parts: [part],
});

const terminalPart = (status = 'completed') => runningPart({
  state: { status, output: 'done', time: { start: 1_000, end: 2_000 } },
});

const controllerFixture = (overrides = {}) => {
  const store = overrides.store ?? createMemoryStore();
  const clock = overrides.clock ?? createFakeClock();
  const fetched = overrides.fetched ?? [message()];
  let fetchIndex = 0;
  const calls = { abort: 0, restart: 0, published: [], incidents: [] };
  const controller = createCommandDeadlineController({
    store,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    graceMs: 0,
    confirmationMs: 0,
    fetchMessage: async () => fetched[Math.min(fetchIndex++, fetched.length - 1)],
    abortSession: async () => { calls.abort += 1; },
    publishPart: ({ part }) => calls.published.push(part),
    listActiveSessions: async () => [],
    restartManagedRuntime: async () => { calls.restart += 1; },
    recordIncident: (incident) => calls.incidents.push(incident),
    ...overrides.options,
  });
  return { controller, store, clock, calls };
};

describe('command deadline controller', () => {
  test('persists a privacy-bounded fingerprint and never extends repeated updates', async () => {
    const fixture = controllerFixture();
    await fixture.controller.observe(partEvent(), '/repo');
    const first = [...fixture.store.records.values()][0];
    expect(first.deadlineAt).toBe(2_000);
    expect(JSON.stringify(first)).not.toContain('secret mutating command');

    fixture.clock.set(1_500);
    await fixture.controller.observe(partEvent(runningPart({
      state: {
        status: 'running',
        input: { command: 'changed', timeout: DEFAULT_COMMAND_TIMEOUT_MS },
        time: { start: 1_500 },
      },
    })), '/repo');
    expect([...fixture.store.records.values()][0].deadlineAt).toBe(2_000);
  });

  test('clears a call that reaches terminal state before its deadline', async () => {
    const fixture = controllerFixture();
    await fixture.controller.observe(partEvent(), '/repo');
    await fixture.controller.observe(partEvent(terminalPart()), '/repo');
    expect(fixture.store.records.size).toBe(0);
    expect(fixture.calls.abort).toBe(0);
    expect(fixture.controller.getStatus()).toMatchObject({ activeCount: 0, lastOutcome: 'cleared' });
  });

  test('lets authoritative completion win the reconciliation race', async () => {
    const fixture = controllerFixture({ fetched: [message(terminalPart())] });
    await fixture.controller.observe(partEvent(), '/repo');
    fixture.clock.set(2_000);
    await fixture.controller.reconcile();
    expect(fixture.calls.abort).toBe(0);
    expect(fixture.calls.published).toHaveLength(1);
    expect(fixture.controller.getStatus()).toMatchObject({ recoveredCount: 1, activeCount: 0 });
  });

  test('treats a replaced exact call as authoritative and never replays it', async () => {
    const fixture = controllerFixture({
      fetched: [{ info: { id: 'msg_1', sessionID: 'ses_1' }, parts: [] }],
    });
    await fixture.controller.observe(partEvent(), '/repo');
    fixture.clock.set(2_000);
    await fixture.controller.reconcile();
    expect(fixture.calls.abort).toBe(0);
    expect(fixture.store.records.size).toBe(0);
  });

  test('aborts the exact session once and publishes the post-abort terminal part', async () => {
    const fixture = controllerFixture({ fetched: [message(), message(terminalPart('aborted'))] });
    await fixture.controller.observe(partEvent(), '/repo');
    fixture.clock.set(2_000);
    await fixture.controller.reconcile();
    expect(fixture.calls.abort).toBe(1);
    expect(fixture.calls.published[0].state.status).toBe('aborted');
    expect(fixture.store.records.size).toBe(0);
  });

  test('preserves other active sessions and does not issue a second abort', async () => {
    const fixture = controllerFixture({
      options: { listActiveSessions: async () => ['ses_1', 'ses_2'] },
    });
    await fixture.controller.observe(partEvent(), '/repo');
    fixture.clock.set(2_000);
    await fixture.controller.reconcile();
    await fixture.controller.reconcile();
    expect(fixture.calls.abort).toBe(1);
    expect(fixture.calls.restart).toBe(0);
    expect(fixture.controller.getStatus()).toMatchObject({
      activeCount: 1,
      unresolvedCount: 1,
      lastOutcome: 'unresolved',
    });
  });

  test('never restarts an external runtime', async () => {
    const fixture = controllerFixture({
      options: {
        isExternalRuntime: async () => true,
        listActiveSessions: async () => ['ses_1'],
      },
    });
    await fixture.controller.observe(partEvent(), '/repo');
    fixture.clock.set(2_000);
    await fixture.controller.reconcile();
    expect(fixture.calls.abort).toBe(1);
    expect(fixture.calls.restart).toBe(0);
    expect(fixture.controller.getStatus().unresolvedCount).toBe(1);
  });

  test('sanitizes the unresolved status error before exposing it', async () => {
    const fixture = controllerFixture({
      options: {
        listActiveSessions: async () => ['ses_1', 'ses_2'],
        sanitizeError: (error) => error.replace('Other sessions', '<SANITIZED> sessions'),
      },
    });
    await fixture.controller.observe(partEvent(), '/repo');
    fixture.clock.set(2_000);
    await fixture.controller.reconcile();
    expect(fixture.controller.getStatus().lastError).toStartWith('<SANITIZED> sessions');
  });

  test('restarts managed OpenCode only when the overdue call is the sole active session', async () => {
    const fixture = controllerFixture({
      options: { listActiveSessions: async () => ['ses_1'] },
    });
    await fixture.controller.observe(partEvent(), '/repo');
    fixture.clock.set(2_000);
    await fixture.controller.reconcile();
    expect(fixture.calls.abort).toBe(1);
    expect(fixture.calls.restart).toBe(1);
    expect(fixture.calls.published[0]).toMatchObject({ state: { status: 'error' } });
    expect(fixture.controller.getStatus()).toMatchObject({ activeCount: 0, recoveredCount: 1 });
  });

  test('restores an overdue persisted call after restart or system sleep', async () => {
    const record = validateCommandDeadlineRecord({
      fingerprint: {
        sessionID: 'ses_1',
        messageID: 'msg_1',
        partID: 'part_1',
        callID: 'call_1',
        tool: 'bash',
      },
      directory: '/repo',
      startedAt: 1_000,
      deadlineAt: 2_000,
      phase: 'active',
      abortRequestedAt: null,
    });
    const store = createMemoryStore([{ key: 'persisted', record }]);
    const clock = createFakeClock(20_000);
    const fixture = controllerFixture({
      store,
      clock,
      fetched: [message(terminalPart())],
    });
    await fixture.controller.initialize();
    await fixture.controller.reconcile();
    expect(fixture.calls.abort).toBe(0);
    expect(store.records.size).toBe(0);
    expect(fixture.controller.getStatus().recoveredCount).toBe(1);
  });
});
