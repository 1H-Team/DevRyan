import { describe, expect, it } from 'vitest';

import { detectPlanReadyRevision } from './plan-ready.js';

const planModePart = () => ({
  type: 'text',
  synthetic: true,
  text: 'User has requested to enter plan mode. Inspect before proposing changes.',
});

const user = (id, parts = [{ type: 'text', text: 'Make a plan' }]) => ({
  info: { id, role: 'user', time: { created: 1 } },
  parts,
});

const assistant = (id, parentID, parts, overrides = {}) => ({
  info: {
    id,
    parentID,
    role: 'assistant',
    finish: 'stop',
    time: { created: 2, completed: 3 },
    ...overrides,
  },
  parts,
});

const structuredPlan = '# Plan\n\n## Context\nInspect the current flow.\n\n## Implementation\nAdd the event.';

describe('detectPlanReadyRevision', () => {
  it('recognizes a terminal sentinel snapshot before its parent history is visible', () => {
    const result = detectPlanReadyRevision([
      assistant('asst_1', 'usr_missing', [{ type: 'text', text: `<!--plan-->\n${structuredPlan}` }]),
    ]);

    expect(result).toMatchObject({
      sourceMessageId: 'asst_1',
      sourceParentMessageId: 'usr_missing',
      planText: structuredPlan,
    });
  });

  it('recognizes an explicit sentinel-backed plan without local plan-mode state', () => {
    const result = detectPlanReadyRevision([
      user('usr_1'),
      assistant('asst_1', 'usr_1', [{ type: 'text', text: `Preamble\n<!--plan-->\n${structuredPlan}` }]),
    ]);

    expect(result).toMatchObject({ sourceMessageId: 'asst_1', planText: `${structuredPlan}` });
  });

  it('recognizes structured text and reasoning plans from plan-mode revisions', () => {
    const textResult = detectPlanReadyRevision([
      user('usr_1', [planModePart()]),
      assistant('asst_1', 'usr_1', [{ type: 'text', text: structuredPlan }]),
    ]);
    expect(textResult?.sourceMessageId).toBe('asst_1');

    const reasoningResult = detectPlanReadyRevision([
      user('usr_2', [planModePart()]),
      assistant('asst_2', 'usr_2', [
        { type: 'text', text: 'The plan is ready.' },
        { type: 'reasoning', text: structuredPlan },
      ]),
    ]);
    expect(reasoningResult).toMatchObject({ sourceMessageId: 'asst_2', planText: structuredPlan });
  });

  it('selects the last canonical plan while allowing a completed epilogue sibling', () => {
    const result = detectPlanReadyRevision([
      user('usr_1', [planModePart()]),
      assistant('asst_1', 'usr_1', [{ type: 'text', text: structuredPlan }]),
      assistant('asst_2', 'usr_1', [{ type: 'text', text: 'Ready for review.' }]),
    ]);

    expect(result?.sourceMessageId).toBe('asst_1');
  });

  it('uses the latest revised plan source', () => {
    const revisedPlan = '# Revised plan\n\n## Context\nRe-check.\n\n## Verification\nRun tests.';
    const result = detectPlanReadyRevision([
      user('usr_1', [planModePart()]),
      assistant('asst_1', 'usr_1', [{ type: 'text', text: structuredPlan }]),
      user('usr_2', [planModePart()]),
      assistant('asst_2', 'usr_2', [{ type: 'text', text: revisedPlan }]),
    ]);

    expect(result).toMatchObject({ sourceMessageId: 'asst_2', planText: revisedPlan });
  });

  it('rejects incomplete siblings and running tools', () => {
    expect(detectPlanReadyRevision([
      user('usr_1', [planModePart()]),
      assistant('asst_1', 'usr_1', [{ type: 'text', text: structuredPlan }]),
      assistant('asst_2', 'usr_1', [{ type: 'text', text: 'Still working' }], { time: { created: 2 } }),
    ])).toBeNull();

    expect(detectPlanReadyRevision([
      user('usr_1', [planModePart()]),
      assistant('asst_1', 'usr_1', [
        { type: 'text', text: structuredPlan },
        { type: 'tool', state: { status: 'running' } },
      ]),
    ])).toBeNull();
  });

  it('does not treat ordinary markdown or plan implementation completion as a new proposal', () => {
    expect(detectPlanReadyRevision([
      user('usr_1'),
      assistant('asst_1', 'usr_1', [{ type: 'text', text: structuredPlan }]),
    ])).toBeNull();

    expect(detectPlanReadyRevision([
      user('usr_1', [planModePart()]),
      assistant('asst_1', 'usr_1', [{ type: 'text', text: structuredPlan }]),
      user('usr_2', [{
        type: 'text',
        synthetic: true,
        text: '[openchamber-plan-action:v1] {"action":"implement"}',
      }]),
      assistant('asst_2', 'usr_2', [{ type: 'text', text: 'Implemented.' }]),
    ])).toBeNull();
  });
});
