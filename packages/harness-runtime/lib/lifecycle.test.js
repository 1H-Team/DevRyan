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

  test('distinguishes a session failure from user cancellation', () => {
    const events = [];
    const tracker = createLifecycleTracker({ onTurnEvent: (event) => events.push(event) });
    tracker.recordPromptAccepted({ sessionID: 'ses_abort', messageID: 'msg_1' });
    tracker.processEvent({
      type: 'session.error',
      properties: { sessionID: 'ses_abort' },
    });
    expect(events.at(-1)).toMatchObject({ type: 'turn_failed', sessionID: 'ses_abort' });
  });
});

 test.each([false, true])('terminal assistant error corrects idle ordering (idle first: %s)', (idleFirst) => {
   const events = [];
   const tracker = createLifecycleTracker({ onTurnEvent: (event) => events.push(event) });
   tracker.recordPromptAccepted({ sessionID: 'ses_1', messageID: 'msg_user' });
   const info = { id: 'msg_assistant', sessionID: 'ses_1', parentID: 'msg_user', role: 'assistant' };
   tracker.processEvent({ type: 'message.updated', properties: { info } });
   const idle = { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } };
   if (idleFirst) tracker.processEvent(idle);
   const failed = { type: 'message.updated', properties: { info: { ...info, time: { completed: 100 }, error: { name: 'UnknownError' } } } };
   tracker.processEvent(failed); tracker.processEvent(failed); tracker.processEvent(idle);
   expect(events.filter((event) => event.type === 'turn_failed')).toHaveLength(1);
   expect(events.filter((event) => event.type === 'turn_completed')).toHaveLength(idleFirst ? 1 : 0);
 });

 test('a late error corrects only its own turn while newer input remains active', () => {
   const events = [];
   const tracker = createLifecycleTracker({ onTurnEvent: (event) => events.push(event) });
   tracker.recordPromptAccepted({ sessionID: 'ses_1', messageID: 'msg_old' });
   const old = { id: 'msg_old_assistant', parentID: 'msg_old', role: 'assistant', sessionID: 'ses_1' };
   tracker.processEvent({ type: 'message.updated', properties: { info: old } });
   tracker.processEvent({ type: 'session.idle', properties: { sessionID: 'ses_1' } });
   tracker.recordPromptAccepted({ sessionID: 'ses_1', messageID: 'msg_new' });
   tracker.processEvent({ type: 'message.updated', properties: { info: { ...old, time: { completed: 100 }, error: { name: 'UnknownError' } } } });
   expect(tracker.getActiveTurn('ses_1')?.userMessageID).toBe('msg_new');
   expect(events.filter((event) => event.type === 'turn_failed').map((event) => event.userMessageID)).toEqual(['msg_old']);
 });

 test('a first-seen finalized failure retains assistant and tool correlation', () => {
   const events = [];
   const tracker = createLifecycleTracker({ onTurnEvent: (event) => events.push(event) });
   tracker.recordPromptAccepted({ sessionID: 'ses_1', messageID: 'msg_user' });
   tracker.processEvent({ type: 'message.updated', properties: { info: { id: 'msg_assistant', parentID: 'msg_user',
     sessionID: 'ses_1', role: 'assistant', time: { completed: 100 }, error: { name: 'UnknownError' } } } });
   expect(events.map((event) => event.type)).toEqual(['turn_started', 'assistant_message_started', 'turn_failed']);
   tracker.processEvent({ type: 'message.part.updated', properties: { part: { id: 'part_tool', messageID: 'msg_assistant',
     sessionID: 'ses_1', tool: 'edit', state: { status: 'error' } } } });
   expect(events.at(-1)).toMatchObject({ type: 'tool_completed', userMessageID: 'msg_user', assistantMessageID: 'msg_assistant' });
 });

 test('late updates from a known earlier assistant cannot fail the current step', () => {
   const events = [];
   const tracker = createLifecycleTracker({ onTurnEvent: (event) => events.push(event) });
   tracker.recordPromptAccepted({ sessionID: 'ses_1', messageID: 'msg_user' });
   const info = { id: 'msg_old', sessionID: 'ses_1', role: 'assistant', parentID: 'msg_user' };
   tracker.processEvent({ type: 'message.updated', properties: { info } });
   tracker.processEvent({ type: 'message.updated', properties: { info: { ...info, id: 'msg_new' } } });
   tracker.processEvent({ type: 'message.updated', properties: { info } });
   tracker.processEvent({ type: 'message.updated', properties: { info: { ...info, time: { completed: 100 }, error: { name: 'UnknownError' } } } });
   expect(events.filter((event) => event.type === 'turn_failed')).toHaveLength(0);
   expect(tracker.getActiveTurn('ses_1')?.assistantMessageID).toBe('msg_new');
 });

test('session error immediately following idle corrects that turn once', () => {
  const events = [];
  const tracker = createLifecycleTracker({ clock: () => 1000, onTurnEvent: (event) => events.push(event) });
  tracker.recordPromptAccepted({ sessionID: 's', messageID: 'u' });
  tracker.processEvent({ type: 'session.idle', properties: { sessionID: 's' } });
  const error = { type: 'session.error', properties: { sessionID: 's', error: { name: 'UnknownError' } } };
  tracker.processEvent(error); tracker.processEvent(error);
  expect(events.filter((event) => event.type === 'turn_failed').map((event) => event.userMessageID)).toEqual(['u']);
});

test('uncorrelated error after a previous idle cannot fail a newer prompt', () => {
  const events = [];
  const tracker = createLifecycleTracker({ clock: () => 1000, onTurnEvent: (event) => events.push(event) });
  tracker.recordPromptAccepted({ sessionID: 's', messageID: 'old' });
  tracker.processEvent({ type: 'session.idle', properties: { sessionID: 's' } });
  tracker.recordPromptAccepted({ sessionID: 's', messageID: 'new' });
  tracker.processEvent({ type: 'session.error', properties: { sessionID: 's', error: { name: 'UnknownError' } } });
  expect(events.filter((event) => event.type === 'turn_failed')).toHaveLength(0);
  tracker.processEvent({ type: 'session.error', properties: { sessionID: 's', messageID: 'old', error: { name: 'UnknownError' } } });
  expect(events.filter((event) => event.type === 'turn_failed').map((event) => event.userMessageID)).toEqual(['old']);
});

test('ambiguous errors cannot rewrite a newer completed turn or cascade through older completions', () => {
  const events = [];
  const tracker = createLifecycleTracker({ clock: () => 1000, onTurnEvent: (event) => events.push(event) });
  for (const messageID of ['old', 'new']) {
    tracker.recordPromptAccepted({ sessionID: 's', messageID });
    tracker.processEvent({ type: 'session.idle', properties: { sessionID: 's' } });
  }
  const error = { type: 'session.error', properties: { sessionID: 's', error: { name: 'UnknownError' } } };
  tracker.processEvent(error);
  expect(events.filter((event) => event.type === 'turn_failed')).toHaveLength(0);
  tracker.processEvent({ ...error, properties: { ...error.properties, messageID: 'old' } });
  tracker.processEvent(error);
  expect(events.filter((event) => event.type === 'turn_failed').map((event) => event.userMessageID)).toEqual(['old']);
});

describe('operator aborts and runtime exits settled at idle', () => {
  const terminal = (events) => events.filter((event) => ['turn_completed', 'turn_failed', 'turn_aborted'].includes(event.type))
    .map((event) => [event.type, event.userMessageID, event.reason]);
  const setup = () => {
    const events = [];
    const tracker = createLifecycleTracker({ clock: () => 1000, onTurnEvent: (event) => events.push(event) });
    tracker.recordPromptAccepted({ sessionID: 's', messageID: 'u' });
    return { events, tracker };
  };

  test('an abort during a retry wait settles as aborted, not completed', () => {
    const { events, tracker } = setup();
    expect(tracker.recordAbortRequested({ sessionID: 's' })).toBe(true);
    tracker.processEvent({ type: 'session.status', properties: { sessionID: 's', status: { type: 'idle' } } });
    // OpenCode may still publish the cancellation afterwards: no second terminal event.
    tracker.processEvent({ type: 'session.error', properties: { sessionID: 's', error: { name: 'MessageAbortedError' } } });
    expect(terminal(events)).toEqual([['turn_aborted', 'u', 'abort_requested']]);
  });

  test('an abort without an active turn is a no-op and a withdrawn abort completes normally', () => {
    const idle = createLifecycleTracker();
    expect(idle.recordAbortRequested({ sessionID: 'none' })).toBe(false);
    const { events, tracker } = setup();
    tracker.recordAbortRequested({ sessionID: 's' });
    tracker.withdrawAbortRequest({ sessionID: 's' });
    tracker.processEvent({ type: 'session.idle', properties: { sessionID: 's' } });
    expect(terminal(events)).toEqual([['turn_completed', 'u', null]]);
  });

  test('a runtime exit settles as failed unless the user already asked to stop', () => {
    const { events, tracker } = setup();
    expect(tracker.recordRuntimeInterrupted({ sessionID: 's' })).toBe(true);
    tracker.processEvent({ type: 'session.idle', properties: { sessionID: 's' } });
    expect(terminal(events)).toEqual([['turn_failed', 'u', 'runtime_exit']]);

    const stopped = setup();
    stopped.tracker.recordAbortRequested({ sessionID: 's' });
    expect(stopped.tracker.recordRuntimeInterrupted({ sessionID: 's' })).toBe(false);
    stopped.tracker.processEvent({ type: 'session.idle', properties: { sessionID: 's' } });
    expect(terminal(stopped.events)).toEqual([['turn_aborted', 'u', 'abort_requested']]);
  });

  test('a pending abort never carries over to the next turn', () => {
    const { events, tracker } = setup();
    tracker.recordAbortRequested({ sessionID: 's' });
    tracker.processEvent({ type: 'session.error', properties: { sessionID: 's', error: { name: 'MessageAbortedError' } } });
    tracker.recordPromptAccepted({ sessionID: 's', messageID: 'next' });
    tracker.processEvent({ type: 'session.idle', properties: { sessionID: 's' } });
    expect(terminal(events)).toEqual([['turn_aborted', 'u', 'session.error'], ['turn_completed', 'next', null]]);
  });
});
