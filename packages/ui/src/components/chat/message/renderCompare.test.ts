import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import {
  areRelevantTurnGroupingContextsEqual,
  areRenderRelevantMessagesEqual,
  areRenderRelevantPartsEqual,
} from './renderCompare';
import type { TurnGroupingContext } from '../lib/turns/types';

type TestTurnGroupingContext = TurnGroupingContext & {
  isTurnWorking: boolean;
};

const createTurnContext = (overrides: Partial<TestTurnGroupingContext> = {}): TestTurnGroupingContext => ({
  turnId: 'turn-1',
  isFirstAssistantInTurn: true,
  isLastAssistantInTurn: true,
  hasTools: true,
  hasReasoning: false,
  isWorking: false,
  isTurnWorking: false,
  ...overrides,
});

describe('areRelevantTurnGroupingContextsEqual', () => {
  test('treats active message working state as render-relevant for assistant messages', () => {
    const idle = createTurnContext({ isWorking: false });
    const working = createTurnContext({ isWorking: true });

    expect(areRelevantTurnGroupingContextsEqual(idle, working, 'assistant-1', false)).toBe(false);
  });

  test('treats turn-level working state as render-relevant for assistant messages', () => {
    const idle = createTurnContext({ isTurnWorking: false });
    const working = createTurnContext({ isTurnWorking: true });

    expect(areRelevantTurnGroupingContextsEqual(idle, working, 'assistant-1', false)).toBe(false);
  });

  test('ignores turn-level working state for user messages', () => {
    const idle = createTurnContext({ isTurnWorking: false });
    const working = createTurnContext({ isTurnWorking: true });

    expect(areRelevantTurnGroupingContextsEqual(idle, working, 'user-1', true)).toBe(true);
  });

  test('treats summary source changes as render-relevant for assistant messages', () => {
    const first = createTurnContext({ summarySourceMessageId: 'assistant-1', summarySourcePartId: 'part-1' });
    const second = createTurnContext({ summarySourceMessageId: 'assistant-2', summarySourcePartId: 'part-2' });

    expect(areRelevantTurnGroupingContextsEqual(first, second, 'assistant-1', false)).toBe(false);
  });

  test('treats turn-level plan mode source changes as render-relevant for assistant messages', () => {
    const normal = createTurnContext({ isPlanModeSource: false });
    const planMode = createTurnContext({ isPlanModeSource: true });

    expect(areRelevantTurnGroupingContextsEqual(normal, planMode, 'assistant-1', false)).toBe(false);
  });

  test('treats the captured rationale level as render-relevant for assistant messages', () => {
    const concise = createTurnContext({ responseStyleLevel: 'concise' });
    const detailed = createTurnContext({ responseStyleLevel: 'detailed' });

    expect(areRelevantTurnGroupingContextsEqual(concise, detailed, 'assistant-1', false)).toBe(false);
  });

  test('treats active activity ownership changes as render-relevant', () => {
    const firstOwner = createTurnContext({ activityOwnerMessageId: 'assistant-1' });
    const nextOwner = createTurnContext({ activityOwnerMessageId: 'assistant-2' });

    expect(areRelevantTurnGroupingContextsEqual(firstOwner, nextOwner, 'assistant-1', false)).toBe(false);
  });
});

describe('areRenderRelevantMessagesEqual', () => {
  test('treats terminal assistant completion info as render-relevant', () => {
    const streamingInfo = {
      id: 'assistant-1',
      sessionID: 'session-1',
      role: 'assistant',
      time: { created: 1 },
    } as Message;
    const completedInfo = {
      ...streamingInfo,
      finish: 'stop',
      time: { created: 1, completed: 2 },
    } as Message;

    expect(areRenderRelevantMessagesEqual(
      { info: streamingInfo, parts: [] },
      { info: completedInfo, parts: [] },
    )).toBe(false);
  });

  test('treats final tool part state as render-relevant', () => {
    const running = {
      id: 'tool-1',
      messageID: 'assistant-1',
      type: 'tool',
      tool: 'edit',
      state: { status: 'running', time: { start: 1 } },
    } as unknown as Part;
    const completed = {
      ...running,
      state: { status: 'completed', time: { start: 1, end: 2 } },
    } as unknown as Part;

    expect(areRenderRelevantPartsEqual([running], [completed])).toBe(false);
  });

  test('treats managed transport recovery presentation changes as render-relevant', () => {
    const info = {
      id: 'assistant-1',
      sessionID: 'session-1',
      role: 'assistant',
      time: { created: 1, completed: 2 },
    } as Message;

    expect(areRenderRelevantMessagesEqual(
      {
        info,
        parts: [],
        presentation: {
          managedTransportRecovery: { kind: 'connection_failure', state: 'recovering' },
        },
      },
      {
        info,
        parts: [],
        presentation: {
          managedTransportRecovery: { kind: 'connection_failure', state: 'recovered' },
        },
      },
    )).toBe(false);
  });

  test('treats managed abort recovery presentation changes as render-relevant', () => {
    const info = {
      id: 'assistant-aborted',
      sessionID: 'session-1',
      role: 'assistant',
      time: { created: 1, completed: 2 },
    } as Message;

    expect(areRenderRelevantMessagesEqual(
      {
        info,
        parts: [],
        presentation: { managedAbortRecovery: { state: 'continuing' } },
      },
      {
        info,
        parts: [],
        presentation: { managedAbortRecovery: { state: 'manual_recovery' } },
      },
    )).toBe(false);
  });
});
