import { describe, expect, test } from 'bun:test';
import {
  buildPlanImplementationSyntheticParts,
  buildPlanSendPromptVariables,
  getPlanSendPlanMode,
} from './planSend';
import { parsePlanImplementationRequestPart } from '@/lib/messages/actionablePlan';
import type { Part } from '@opencode-ai/sdk/v2/client';

describe('plan send helpers', () => {
  test('implement sends the authoritative plan path without requiring an inline body', () => {
    expect(buildPlanSendPromptVariables({
      action: 'implement',
      title: 'Fix onboarding',
      path: '/repo/.opencode/plans/fix-onboarding.md',
    })).toEqual({
      plan_title: 'Fix onboarding',
      plan_path: '/repo/.opencode/plans/fix-onboarding.md',
    });

    expect(getPlanSendPlanMode('implement')).toBe(false);
  });

  test('rejects implementation when the authoritative plan path is empty', () => {
    expect(() => buildPlanSendPromptVariables({
      action: 'implement',
      title: 'Fix onboarding',
      path: '   ',
    })).toThrow('A saved plan file path is required');
  });

  test('never sends a competing inline body when a saved file is authoritative', () => {
    expect(buildPlanSendPromptVariables({
      action: 'implement',
      title: 'Fix onboarding',
      path: '/repo/.opencode/plans/fix-onboarding.md',
      body: '# Fix onboarding\n\n- Do the work',
    })).toEqual({
      plan_title: 'Fix onboarding',
      plan_path: '/repo/.opencode/plans/fix-onboarding.md',
    });
  });

  test('improve does not send an implementation body or override plan mode', () => {
    expect(buildPlanSendPromptVariables({
      action: 'improve',
      title: 'Fix onboarding',
      path: '/repo/.opencode/plans/fix-onboarding.md',
      body: '# Fix onboarding\n\n- Do the work',
    })).toEqual({
      plan_title: 'Fix onboarding',
      plan_path: '/repo/.opencode/plans/fix-onboarding.md',
    });

    expect(getPlanSendPlanMode('improve')).toBe(undefined);
  });
});

describe('buildPlanImplementationSyntheticParts', () => {
  test('keeps the authoritative marker separate from editable implementation instructions', () => {
    const parts = buildPlanImplementationSyntheticParts({
      sourceSessionId: 'session-a',
      sourceMessageId: 'assistant-a',
      instructions: 'Read the saved plan and implement it.',
    });

    expect(parts).toHaveLength(2);
    expect(parsePlanImplementationRequestPart({
      id: 'part-a',
      sessionID: 'session-a',
      messageID: 'implementation-a',
      type: 'text',
      ...parts[0],
    } as Part)).toEqual({
      action: 'implement',
      sourceSessionId: 'session-a',
      sourceMessageId: 'assistant-a',
      planIndex: 0,
    });
    expect(parts[1]).toEqual({
      synthetic: true,
      text: 'Read the saved plan and implement it.',
    });
  });
});
