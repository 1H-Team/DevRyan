import { describe, expect, test } from 'bun:test';

import { createJournalTrimmer } from './journal-trim.js';

const createFakeClock = () => {
  let current = 0;
  let sequence = 0;
  const tasks = new Map();
  return {
    now: () => current,
    setTimeout(callback, delay) {
      const timer = { id: ++sequence, at: current + delay, unref() {} };
      tasks.set(timer.id, { timer, callback });
      return timer;
    },
    clearTimeout(timer) {
      if (timer) tasks.delete(timer.id);
    },
    advance(ms) {
      current += ms;
      const ready = [...tasks.values()]
        .filter(({ timer }) => timer.at <= current)
        .sort((left, right) => left.timer.at - right.timer.at);
      for (const task of ready) {
        tasks.delete(task.timer.id);
        task.callback();
      }
    },
  };
};

const event = (type, properties = {}, sessionID = 'ses_1') => ({
  type: 'open_code_event',
  at: 1,
  sessionID,
  payload: { type, properties },
});
describe('diagnostic journal trimming', () => {
  test('aggregates identical historical failures while preserving live failures and changed reasons', () => {
    const trimmer = createJournalTrimmer();
    const historical = { type: 'log', event: 'session_changes_capture', sessionID: 'ses_1', at: 1,
      payload: { code: 'invalid_change_receipt', phase: 'history', callID: 'call_1', reason: 'missing_identity' } };
    expect(trimmer.admit(historical)).toEqual([]);
    expect(trimmer.admit({ ...historical, at: 2 })).toEqual([]);
    const changed = { ...historical, payload: { ...historical.payload, reason: 'changed_identity' } };
    expect(trimmer.admit(changed)).toEqual([]);
    const live = { ...historical, payload: { ...historical.payload, phase: 'receipt' } };
    expect(trimmer.admit(live)).toEqual([live]);
    expect(trimmer.flushAll()).toEqual([{ ...historical, at: 2, coalesced: 2 }, { ...changed, coalesced: 1 }]);
    expect(trimmer.stats().ses_1.coalescedDiagnostics).toBe(1);
  });

  test('keeps recovery generations and state transitions distinct from repeated observations', () => {
    const trimmer = createJournalTrimmer();
    const failure = { type: 'lifecycle', event: 'provider_recovery_observation_failed', sessionID: 'ses_1', at: 1,
      payload: { assistantMessageID: 'msg_1', generation: 1, reason: 'owner_unavailable' } };
    trimmer.admit(failure);
    trimmer.admit({ ...failure, at: 2 });
    trimmer.admit({ ...failure, payload: { ...failure.payload, generation: 2 } });
    const transition = { ...failure, event: 'objective_state' };
    expect(trimmer.admit(transition)).toEqual([transition]);
    expect(trimmer.flushAll().map((row) => [row.payload.generation, row.coalesced])).toEqual([[1, 2], [2, 1]]);
  });

  test('drops deltas without gaps and counts the intentional trim', () => {
    const trimmer = createJournalTrimmer();
    expect(trimmer.admit(event('message.part.delta'))).toEqual([]);
    expect(trimmer.stats().ses_1).toMatchObject({ trimmedDeltas: 1 });
  });

  test('coalesces part updates last-write-wins and flushes on completion', () => {
    const trimmer = createJournalTrimmer();
    const first = event('message.part.updated', { messageID: 'msg_1', part: { id: 'part_1', text: 'a' } });
    const second = event('message.part.updated', { messageID: 'msg_1', part: { id: 'part_1', text: 'b', completed: true } });
    expect(trimmer.admit(first)).toEqual([]);
    expect(trimmer.admit(second)).toMatchObject([{
      coalesced: 2,
      payload: { properties: { part: { text: 'b' } } },
    }]);
    expect(trimmer.stats().ses_1.coalescedParts).toBe(1);
  });

  test('debounces pending updates and flushes session state before idle', () => {
    const clock = createFakeClock();
    const flushed = [];
    const trimmer = createJournalTrimmer({
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      debounceMs: 2_000,
      onFlush: (records) => flushed.push(...records),
    });
    trimmer.admit(event('session.updated', { info: { id: 'ses_1', title: 'one' } }));
    trimmer.admit(event('session.updated', { info: { id: 'ses_1', title: 'two' } }));
    clock.advance(1_999);
    expect(flushed).toEqual([]);
    clock.advance(1);
    expect(flushed).toMatchObject([{ coalesced: 2 }]);

    trimmer.admit(event('message.part.updated', { messageID: 'msg_2', part: { id: 'part_2' } }));
    const ready = trimmer.admit(event('session.status', { status: { type: 'idle' } }));
    expect(ready.map((record) => record.payload.type)).toEqual([
      'message.part.updated',
      'session.status',
    ]);
  });

  test('coalesces only property-free unattributed sync events', () => {
    const trimmer = createJournalTrimmer();
    const first = event('sync', {}, '');
    const second = { ...event('sync', {}, ''), at: 2 };

    expect(trimmer.admit(first)).toEqual([]);
    expect(trimmer.admit(second)).toEqual([]);
    expect(trimmer.flushAll()).toMatchObject([{
      at: 2,
      coalesced: 2,
      payload: { type: 'sync', properties: {} },
    }]);
    expect(trimmer.stats().__runtime__.coalescedRuntimeSyncs).toBe(1);

    expect(trimmer.admit(event('sync', { revision: 1 }, ''))).toEqual([
      event('sync', { revision: 1 }, ''),
    ]);
    expect(trimmer.admit(event('sync', {}, 'ses_2'))).toEqual([
      event('sync', {}, 'ses_2'),
    ]);
  });
});
