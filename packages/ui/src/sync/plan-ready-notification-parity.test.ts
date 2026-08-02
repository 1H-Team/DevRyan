import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2/client';

import { detectPlanReadyRevision } from '../../../web/server/lib/notifications/plan-ready.js';
import { detectPlanProposedCandidate } from './plan-proposed-detection';
import { INITIAL_STATE, type State } from './types';

const SESSION_ID = 'ses_plan_ready';

type FixtureMessage = {
  info: Record<string, unknown> & { id: string; role: 'user' | 'assistant' };
  parts: Part[];
};

const user = (id: string, parts: Part[], extra: Record<string, unknown> = {}): FixtureMessage => ({
  info: { id, sessionID: SESSION_ID, role: 'user', time: { created: 1 }, ...extra },
  parts,
});

const assistant = (
  id: string,
  parentID: string,
  parts: Part[],
  extra: Record<string, unknown> = {},
): FixtureMessage => ({
  info: {
    id,
    parentID,
    sessionID: SESSION_ID,
    role: 'assistant',
    finish: 'stop',
    time: { created: 2, completed: 3 },
    ...extra,
  },
  parts,
});

const part = (messageID: string, type: 'text' | 'reasoning', text: string, synthetic = false): Part => ({
  id: `${messageID}_${type}`,
  messageID,
  sessionID: SESSION_ID,
  type,
  text,
  synthetic,
} as Part);

const tool = (messageID: string, status: 'pending' | 'running' | 'completed'): Part => ({
  id: `${messageID}_tool`,
  messageID,
  sessionID: SESSION_ID,
  type: 'tool',
  tool: 'read',
  state: { status },
} as Part);

const detectUi = (messages: FixtureMessage[]) => {
  const state = {
    ...INITIAL_STATE,
    message: {
      [SESSION_ID]: messages.map(({ info }) => info as unknown as Message),
    },
    part: Object.fromEntries(messages.map(({ info, parts }) => [info.id, parts])),
  } as State;
  return detectPlanProposedCandidate({
    sessionID: SESSION_ID,
    state,
    isRecordedPlanModeUserMessage: (messageId) => {
      const message = messages.find(({ info }) => info.id === messageId);
      return message?.info.mode === 'plan';
    },
    implementedPlanRequests: new Set(),
  });
};

const expectParity = (messages: FixtureMessage[]) => {
  const ui = detectUi(messages);
  const server = detectPlanReadyRevision(messages);
  expect(server?.sourceMessageId ?? null).toBe(ui?.sourceMessageId ?? null);
  expect(server?.planText ?? null).toBe(ui?.markdown ?? null);
};

const structuredPlan = [
  '# Plan Ready',
  '',
  '## Implementation',
  '',
  '- Add the notification.',
  '',
  '## Verification',
  '',
  '- Verify it.',
].join('\n');

describe('Plan Ready notification classifier parity', () => {
  test('matches sentinel, structured, and reasoning-backed Plan card detection', () => {
    expectParity([
      user('user_sentinel', [part('user_sentinel', 'text', 'Plan it')]),
      assistant('assistant_sentinel', 'user_sentinel', [part('assistant_sentinel', 'text', `Preamble\n<!--plan-->\n${structuredPlan}`)]),
    ]);
    expectParity([
      user('user_structured', [part('user_structured', 'text', 'Plan it')], { mode: 'plan' }),
      assistant('assistant_structured', 'user_structured', [part('assistant_structured', 'text', structuredPlan)]),
    ]);
    expectParity([
      user('user_reasoning', [part('user_reasoning', 'text', 'Plan it')], { mode: 'plan' }),
      assistant('assistant_reasoning', 'user_reasoning', [
        part('assistant_reasoning', 'reasoning', structuredPlan),
        part('assistant_reasoning', 'text', 'Ready for review.'),
      ]),
    ]);
  });

  test('matches multi-message revisions and selects the latest canonical source', () => {
    expectParity([
      user('user_revision', [part('user_revision', 'text', 'Plan it')], { mode: 'plan' }),
      assistant('assistant_v1', 'user_revision', [part('assistant_v1', 'text', `<!--plan-->\n# Plan v1`)]),
      user('user_continue', [part('user_continue', 'text', 'Continue', true)]),
      assistant('assistant_v2', 'user_continue', [part('assistant_v2', 'text', `<!--plan-->\n# Plan v2`)]),
      assistant('assistant_epilogue', 'user_continue', [part('assistant_epilogue', 'text', 'Ready for review.')]),
    ]);
  });

  test('matches rejection of incomplete, unfinished-tool, and ordinary structured output', () => {
    expectParity([
      user('user_incomplete', [part('user_incomplete', 'text', 'Plan it')], { mode: 'plan' }),
      assistant('assistant_incomplete', 'user_incomplete', [part('assistant_incomplete', 'text', structuredPlan)], {
        time: { created: 2 },
      }),
    ]);
    expectParity([
      user('user_tool', [part('user_tool', 'text', 'Plan it')], { mode: 'plan' }),
      assistant('assistant_tool', 'user_tool', [part('assistant_tool', 'text', structuredPlan), tool('assistant_tool', 'running')]),
    ]);
    expectParity([
      user('user_build', [part('user_build', 'text', 'Write docs')]),
      assistant('assistant_build', 'user_build', [part('assistant_build', 'text', structuredPlan)]),
    ]);
  });
});
