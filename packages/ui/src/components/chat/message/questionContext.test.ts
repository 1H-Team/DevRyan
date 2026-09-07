import { describe, expect, test } from 'bun:test';
import type { Message, Part, ToolPart } from '@opencode-ai/sdk/v2';
import { hasQuestionTool } from './questionContext';
import { projectTurnActivity } from '../lib/turns/projectTurnActivity';

const preamble: Part = { id: 'text', messageID: 'm', sessionID: 's', type: 'text', text: 'Which option should I use?' };
const question = (tool = 'question', state: ToolPart['state'] = { status: 'pending', input: {}, raw: '' }): ToolPart => ({
  id: 'tool', messageID: 'm', sessionID: 's', type: 'tool', callID: 'call', tool, state,
});
const message = (parts: Part[], id = 'm') => ({
  info: { id, sessionID: 's', role: 'assistant', finish: 'tool-calls', time: { created: 1 } } as Message,
  parts,
});

describe('question context', () => {
  for (const state of [
    { status: 'pending', input: {}, raw: '' },
    { status: 'running', input: {}, time: { start: 1 } },
    { status: 'completed', input: {}, output: 'answered', title: 'Question', metadata: {}, time: { start: 1, end: 2 } },
    { status: 'error', input: {}, error: 'failed', time: { start: 1, end: 2 } },
  ] satisfies ToolPart['state'][]) test(`retains context for ${state.status} questions`, () => {
    const parts = [preamble, question('question', state)];
    expect(hasQuestionTool(parts)).toBe(true);
    const projected = projectTurnActivity({ turnId: 'turn', assistantMessages: [message(parts)] });
    expect(projected.activityParts.map((part) => part.id)).toEqual(['tool']);
    expect(parts[0]).toBe(preamble);
  });

  test('exact tool matching and delayed arrival do not exempt other messages', () => {
    for (const name of ['ask_question', 'questionnaire', 'QUESTION', 'bash']) expect(hasQuestionTool([question(name)])).toBe(false);
    expect(hasQuestionTool([preamble])).toBe(false);
    const without = projectTurnActivity({ turnId: 'turn', assistantMessages: [message([preamble])] });
    expect(without.activityParts.some((part) => part.kind === 'justification')).toBe(true);
    const withQuestion = projectTurnActivity({ turnId: 'turn', assistantMessages: [message([preamble, question()])] });
    expect(withQuestion.activityParts.some((part) => part.kind === 'justification')).toBe(false);
    const otherText = { ...preamble, id: 'other-text', messageID: 'other' };
    const mixed = projectTurnActivity({ turnId: 'turn', assistantMessages: [message([question()]), message([otherText], 'other')] });
    expect(mixed.activityParts.find((part) => part.id === 'other-text')?.kind).toBe('justification');
  });
});
