import { describe, expect, test } from 'bun:test';

import { createLifecycleTracker } from './lifecycle.js';

describe('turn lifecycle tracker', () => {
  test('correlates prompt, assistant, tool finality, and idle completion', () => {
    let time = 1_000;
    const events = [];
    const tracker = createLifecycleTracker({
      clock: () => time++,
      onTurnEvent: (event) => events.push(event),
    });

    tracker.recordPromptAccepted({
      sessionID: 'ses_1',
      messageID: 'msg_user',
      directory: '/repo',
    });
    tracker.processEvent({
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_assistant',
          sessionID: 'ses_1',
          parentID: 'msg_user',
          role: 'assistant',
        },
      },
    });
    const toolEvent = {
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part_tool',
          messageID: 'msg_assistant',
          sessionID: 'ses_1',
          tool: 'bash',
          state: { status: 'completed' },
        },
      },
    };
    tracker.processEvent(toolEvent);
    tracker.processEvent(toolEvent);
    tracker.processEvent({
      type: 'session.status',
      properties: {
        sessionID: 'ses_1',
        status: { type: 'idle' },
      },
    });

    expect(events.map((event) => event.type)).toEqual([
      'turn_started',
      'assistant_message_started',
      'tool_completed',
      'turn_completed',
      'session_idle',
    ]);
    expect(events[1]).toMatchObject({
      userMessageID: 'msg_user',
      assistantMessageID: 'msg_assistant',
    });
  });

  test('settles an active turn as aborted on a session error', () => {
    const events = [];
    const tracker = createLifecycleTracker({ onTurnEvent: (event) => events.push(event) });
    tracker.recordPromptAccepted({ sessionID: 'ses_abort', messageID: 'msg_1' });
    tracker.processEvent({
      type: 'session.error',
      properties: { sessionID: 'ses_abort' },
    });
    expect(events.at(-1)).toMatchObject({ type: 'turn_aborted', sessionID: 'ses_abort' });
  });
});
