import { describe, expect, test } from 'bun:test';
import type { Event, Message, Session } from '@opencode-ai/sdk/v2/client';
import { applyDirectoryEvent } from '@/sync/event-reducer';
import { INITIAL_STATE, type State } from '@/sync/types';
import { compareSessionsByPinnedAndTime } from './utils';

const session = (id: string, created: number, updated: number): Session => ({
  id,
  title: id,
  directory: '/repo',
  time: { created, updated },
} as Session);

const message = (id: string, sessionID: string, role: 'user' | 'assistant', created: number): Message => ({
  id,
  sessionID,
  role,
  time: { created },
} as Message);

const order = (state: State): string[] => [...state.session]
  .sort((left, right) => compareSessionsByPinnedAndTime(
    left,
    right,
    new Set(),
    state.session_user_activity,
  ))
  .map((item) => item.id);

describe('active sidebar prompt ordering integration', () => {
  test('ignores assistant and session churn until a new root user prompt arrives', () => {
    const first = session('ses_first', 1, 10);
    const second = session('ses_second', 2, 20);
    const state: State = {
      ...INITIAL_STATE,
      session: [first, second],
      message: {
        [first.id]: [message('msg_first_user', first.id, 'user', 100)],
        [second.id]: [message('msg_second_user', second.id, 'user', 200)],
      },
      session_user_activity: {
        [first.id]: 100,
        [second.id]: 200,
      },
    };

    expect(order(state)).toEqual([second.id, first.id]);

    applyDirectoryEvent(state, {
      type: 'session.updated',
      properties: { info: { ...first, time: { created: 1, updated: 10_000 } } },
    } as Event);
    applyDirectoryEvent(state, {
      type: 'message.updated',
      properties: { info: message('msg_first_assistant', first.id, 'assistant', 20_000) },
    } as Event);

    expect(order(state)).toEqual([second.id, first.id]);

    applyDirectoryEvent(state, {
      type: 'message.updated',
      properties: { info: message('msg_first_next_user', first.id, 'user', 30_000) },
    } as Event);

    expect(order(state)).toEqual([first.id, second.id]);
  });
});
