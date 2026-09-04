import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PLAN_IMPLEMENTATION_AGENT,
  buildPlanImplementationSyntheticParts,
  buildPlanSendPromptVariables,
  getPlanSendPlanMode,
  resolvePlanImplementationAgent,
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

describe('resolvePlanImplementationAgent', () => {
  const agents = [
    { name: 'plan', mode: 'primary' },
    { name: 'builder', mode: 'primary' },
    { name: 'orchestrator', mode: 'primary' },
    { name: 'designer', mode: 'primary', hidden: true },
    { name: 'fixer', mode: 'subagent' },
  ];

  test('prefers the session selection, then the draft or last-used agent', () => {
    expect(resolvePlanImplementationAgent({
      sessionAgent: 'orchestrator',
      draftAgent: 'builder',
      agents,
    })).toBe('orchestrator');
    expect(resolvePlanImplementationAgent({
      sessionAgent: null,
      draftAgent: 'orchestrator',
      agents,
    })).toBe('orchestrator');
  });

  test('never resolves to the plan agent', () => {
    expect(resolvePlanImplementationAgent({
      sessionAgent: 'plan',
      draftAgent: 'plan',
      agents,
    })).toBe('builder');
    expect(resolvePlanImplementationAgent({
      sessionAgent: 'plan',
      draftAgent: null,
      agents: [],
      settingsDefaultAgent: 'plan',
    })).toBe(DEFAULT_PLAN_IMPLEMENTATION_AGENT);
  });

  test('skips hidden and non-primary candidates and falls back to the build agent', () => {
    expect(resolvePlanImplementationAgent({
      sessionAgent: 'designer',
      draftAgent: 'fixer',
      agents,
    })).toBe('builder');
  });

  test('falls back to the settings default agent when no build agent exists', () => {
    const noBuilder = [
      { name: 'plan', mode: 'primary' },
      { name: 'orchestrator', mode: 'primary' },
      { name: 'council', mode: 'primary' },
    ];
    expect(resolvePlanImplementationAgent({
      agents: noBuilder,
      settingsDefaultAgent: 'council',
    })).toBe('council');
    expect(resolvePlanImplementationAgent({ agents: noBuilder })).toBe('orchestrator');
  });

  test('trusts explicit names when no agent catalog is known and ends at the built-in build agent', () => {
    expect(resolvePlanImplementationAgent({ sessionAgent: '  custom-agent ', agents: [] })).toBe('custom-agent');
    expect(resolvePlanImplementationAgent({ agents: [] })).toBe(DEFAULT_PLAN_IMPLEMENTATION_AGENT);
    expect(resolvePlanImplementationAgent({})).toBe(DEFAULT_PLAN_IMPLEMENTATION_AGENT);
  });
});
