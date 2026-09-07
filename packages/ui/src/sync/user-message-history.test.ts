import { describe, expect, test } from 'bun:test';
import type { Message, Part, Session } from '@opencode-ai/sdk/v2/client';
import { createStore } from 'zustand/vanilla';
import { buildUserMessageHistory, createUserMessageHistorySelector } from './user-message-history';
import type { State } from './types';

const record = (id: string, created: number, text: string, role: Message['role'] = 'user') => ({
  info: { id, sessionID: 'session', role, time: { created } } as Message,
  parts: [{ id: `part-${id}`, messageID: id, sessionID: 'session', type: 'text', text } as Part],
});

describe('ArrowUp user-message history', () => {
  test('follows transcript chronology across rollover-prone IDs', () => {
    const records = [
      record('msg_fff', 10, 'older prompt'),
      record('msg_assistant', 15, 'answer', 'assistant'),
      record('msg_000', 20, 'newer prompt'),
    ];
    expect(buildUserMessageHistory(records)).toEqual(['newer prompt', 'older prompt']);
  });

  const stateFor = (...records: ReturnType<typeof record>[]): Pick<State, 'message' | 'part' | 'session' | 'revert_transaction'> => ({
    session: [],
    message: { session: records.map((entry) => entry.info) },
    part: Object.fromEntries(records.map((entry) => [entry.info.id, entry.parts])),
    revert_transaction: {},
  });

  test('assistant streaming, tool output, metadata and unrelated sessions keep the same snapshot', () => {
    const user = record('user', 1, 'prompt');
    const assistant = record('assistant', 2, '', 'assistant');
    const store = createStore(() => stateFor(user, assistant));
    const select = createUserMessageHistorySelector('session');
    const original = select(store.getState());
    let previous = original;
    let changes = 0;
    const unsubscribe = store.subscribe((state) => {
      const next = select(state);
      if (next !== previous) changes += 1;
      previous = next;
    });
    for (let index = 0; index < 120; index += 1) {
      store.setState({ part: { ...store.getState().part, assistant: record('assistant', 2, `output ${index}`, 'assistant').parts } });
    }
    store.setState({ message: { ...store.getState().message, unrelated: [record('other', 3, 'other').info] } });
    store.setState({ message: { ...store.getState().message, session: [user.info, { ...assistant.info, time: { created: 2 } }] } });
    expect(previous).toBe(original);
    expect(changes).toBe(0);
    store.setState({ part: { ...store.getState().part, user: record('user', 1, 'edited prompt').parts } });
    expect(changes).toBe(1);
    expect(previous).toEqual(['edited prompt']);
    unsubscribe();
  });

  test('late user text and older pages preserve newest-first transcript ordering', () => {
    const newer = record('msg_000', 20, '');
    newer.parts = [{ id: 'late', messageID: 'msg_000', sessionID: 'session', type: 'text' } as Part];
    let state = stateFor(newer);
    const select = createUserMessageHistorySelector('session');
    const empty = select(state);
    state = { ...state, part: { ...state.part, msg_000: record('msg_000', 20, 'newer').parts } };
    expect(select(state)).toEqual(['newer']);
    const older = record('msg_fff', 10, 'older');
    state = { ...state, message: { session: [older.info, newer.info] }, part: { ...state.part, msg_fff: older.parts } };
    expect(select(state)).toEqual(['newer', 'older']);
    expect(select({ ...state, message: {}, part: {} })).toBe(empty);
  });

  test('pending reverts hide the suffix and failed reverts restore it', () => {
    const state = stateFor(record('first', 1, 'first'), record('second', 2, 'second'));
    const select = createUserMessageHistorySelector('session');
    expect(select(state)).toEqual(['second', 'first']);
    const pending = { messageID: 'second', version: 1, status: 'pending' as const, startedAt: 3 };
    expect(select({ ...state, revert_transaction: { session: pending } })).toEqual(['first']);
    expect(select({ ...state, revert_transaction: { session: { ...pending, status: 'failed' } } })).toEqual(['second', 'first']);
    const session = { id: 'session', revert: { messageID: 'second' } } as Session;
    expect(select({ ...state, session: [session] })).toEqual(['first']);
    expect(select(state)).toEqual(['second', 'first']);
  });

  test('non-text changes do not publish and selectors do not share session or directory state', () => {
    const user = record('user', 1, 'first text');
    const state = stateFor(user);
    const select = createUserMessageHistorySelector('session');
    const initial = select(state);
    const parts = [...user.parts, ...record('extra', 1, 'second text').parts];
    expect(select({ ...state, part: { user: parts } })).toBe(initial);
    expect(createUserMessageHistorySelector('other')(state)).toEqual([]);
    expect(createUserMessageHistorySelector('session')(stateFor(record('user', 1, 'different directory')))).toEqual(['different directory']);
    expect(select(state)).toBe(initial);
  });
});
