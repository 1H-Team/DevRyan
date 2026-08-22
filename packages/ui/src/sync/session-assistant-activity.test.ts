import { describe, expect, test } from 'bun:test';
import type { Message, Session } from '@opencode-ai/sdk/v2/client';
import { getLastVisibleAssistantResponseAt } from './session-assistant-activity';

const message = (id: string, role: Message['role'], time: Record<string, number>, parentID?: string): Message => ({
  id,
  role,
  sessionID: 'session',
  time,
  ...(parentID ? { parentID } : {}),
} as Message);

describe('getLastVisibleAssistantResponseAt', () => {
  test('returns the newest assistant completed timestamp and ignores user messages', () => {
    const latest = getLastVisibleAssistantResponseAt(undefined, [
      message('user', 'user', { created: 5_000 }),
      message('assistant-older', 'assistant', { created: 1_000, completed: 2_000 }),
      message('assistant-newer', 'assistant', { created: 3_000, completed: 4_000 }),
    ]);

    expect(latest).toBe(4_000);
  });

  test('falls back to assistant updated and created timestamps when completion is absent', () => {
    const latest = getLastVisibleAssistantResponseAt(undefined, [
      message('assistant-created', 'assistant', { created: 1_000 }),
      message('assistant-updated', 'assistant', { created: 2_000, updated: 3_000 }),
    ]);

    expect(latest).toBe(3_000);
  });

  test('excludes assistant messages hidden by a session revert boundary', () => {
    const session = {
      id: 'session',
      time: { created: 1, updated: 1 },
      revert: { messageID: 'm3' },
    } as Session;

    const latest = getLastVisibleAssistantResponseAt(session, [
      message('m2', 'assistant', { created: 1_000, completed: 2_000 }),
      message('m3', 'user', { created: 2_500 }),
      message('m4', 'assistant', { created: 3_000, completed: 4_000 }),
    ]);

    expect(latest).toBe(2_000);
  });
});
