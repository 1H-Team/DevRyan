import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2/client';

import { buildPlanImplementationRequestMarker } from '@/lib/messages/actionablePlan';
import { detectPlanImplementationRequestCandidate } from './plan-implementation-detection';
import { INITIAL_STATE, type State } from './types';

const SESSION_ID = 'session-a';
const SOURCE_MESSAGE_ID = 'assistant-plan';
const IMPLEMENTATION_MESSAGE_ID = 'user-implement';

const message = (id: string, role: 'user' | 'assistant', created: number): Message => ({
  id,
  sessionID: SESSION_ID,
  role,
  time: role === 'assistant' ? { created, completed: created + 1 } : { created },
} as Message);

const textPart = (
  messageID: string,
  text: string,
  synthetic = false,
  id = `${messageID}-part`,
): Part => ({
  id,
  sessionID: SESSION_ID,
  messageID,
  type: 'text',
  text,
  synthetic,
} as Part);

const markerPart = (overrides: {
  sourceSessionId?: string;
  sourceMessageId?: string;
  planIndex?: number;
} = {}): Part => textPart(
  IMPLEMENTATION_MESSAGE_ID,
  buildPlanImplementationRequestMarker({
    sourceSessionId: overrides.sourceSessionId ?? SESSION_ID,
    sourceMessageId: overrides.sourceMessageId ?? SOURCE_MESSAGE_ID,
    planIndex: overrides.planIndex ?? 0,
  }),
  true,
  'implementation-marker',
);

const stateWith = ({
  includeImplementationMessage = true,
  marker = markerPart(),
}: {
  includeImplementationMessage?: boolean;
  marker?: Part;
} = {}): State => ({
  ...INITIAL_STATE,
  message: {
    [SESSION_ID]: [
      message('user-plan', 'user', 1),
      message(SOURCE_MESSAGE_ID, 'assistant', 2),
      ...(includeImplementationMessage ? [message(IMPLEMENTATION_MESSAGE_ID, 'user', 4)] : []),
    ],
  },
  part: {
    [SOURCE_MESSAGE_ID]: [
      textPart(SOURCE_MESSAGE_ID, '<!--plan-->\n# Plan\n\n## Implementation\n\n1. Do work.'),
    ],
    [IMPLEMENTATION_MESSAGE_ID]: [marker],
  },
});

describe('detectPlanImplementationRequestCandidate', () => {
  test('reconstructs the exact implementation request from materialized history', () => {
    expect(detectPlanImplementationRequestCandidate({
      sessionID: SESSION_ID,
      state: stateWith(),
    })).toEqual({
      sourceSessionId: SESSION_ID,
      sourceMessageId: SOURCE_MESSAGE_ID,
      implementationMessageId: IMPLEMENTATION_MESSAGE_ID,
      implementationKey: `${SESSION_ID}:${SOURCE_MESSAGE_ID}:plan:0`,
    });
  });

  test('waits for the implementation message when its part arrives first', () => {
    expect(detectPlanImplementationRequestCandidate({
      sessionID: SESSION_ID,
      state: stateWith({ includeImplementationMessage: false }),
    })).toBeNull();
    expect(detectPlanImplementationRequestCandidate({
      sessionID: SESSION_ID,
      state: stateWith(),
    })?.implementationMessageId).toBe(IMPLEMENTATION_MESSAGE_ID);
  });

  test('ignores markers for another session or a nonexistent plan revision', () => {
    expect(detectPlanImplementationRequestCandidate({
      sessionID: SESSION_ID,
      state: stateWith({ marker: markerPart({ sourceSessionId: 'session-b' }) }),
    })).toBeNull();
    expect(detectPlanImplementationRequestCandidate({
      sessionID: SESSION_ID,
      state: stateWith({ marker: markerPart({ sourceMessageId: 'assistant-other' }) }),
    })).toBeNull();
  });

  test('ignores a marker when the referenced assistant message has no plan card', () => {
    const state = stateWith();
    state.part[SOURCE_MESSAGE_ID] = [textPart(SOURCE_MESSAGE_ID, 'Ordinary assistant response.')];
    expect(detectPlanImplementationRequestCandidate({
      sessionID: SESSION_ID,
      state,
    })).toBeNull();
  });
});
