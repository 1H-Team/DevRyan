import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2/client';
import { buildUserMessageHistory } from './sync-context';

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
});
