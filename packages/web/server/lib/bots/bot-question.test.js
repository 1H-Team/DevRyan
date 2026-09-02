import { describe, expect, it } from 'vitest';

import { botQuestionContextText, normalizeBotQuestion } from './bot-question.js';

describe('Bot quick-reply questions', () => {
  it('normalizes string and object options, trims whitespace, and defaults the flags', () => {
    const question = normalizeBotQuestion({
      question: '  Which   plan? ',
      options: ['Monthly', { label: ' Annual ', description: 'Two months free' }, { label: 'Not sure', description: '' }],
    });
    expect(question).toEqual({
      version: 1,
      prompt: 'Which plan?',
      options: [
        { label: 'Monthly', description: null },
        { label: 'Annual', description: 'Two months free' },
        { label: 'Not sure', description: null },
      ],
      multiple: false,
      allowFreeText: true,
    });
    expect(Object.isFrozen(question)).toBe(true);
    expect(normalizeBotQuestion({ prompt: 'Pick', options: ['A'], multiple: true, allowFreeText: false }))
      .toMatchObject({ multiple: true, allowFreeText: false });
  });

  it('rejects empty, oversized, duplicate, or unsupported shapes', () => {
    for (const invalid of [
      null,
      { prompt: '', options: ['A'] },
      { prompt: 'x'.repeat(501), options: ['A'] },
      { prompt: 'Pick', options: [] },
      { prompt: 'Pick', options: ['A', 'B', 'C', 'D', 'E', 'F', 'G'] },
      { prompt: 'Pick', options: ['Same', 'same'] },
      { prompt: 'Pick', options: ['x'.repeat(81)] },
      { prompt: 'Pick', options: [{ label: 'A', description: 'y'.repeat(201) }] },
      { prompt: 'Pick', options: ['A'], multiple: 'yes' },
      { prompt: 'Pick', options: ['A'], extra: true },
    ]) {
      expect(() => normalizeBotQuestion(invalid)).toThrow(expect.objectContaining({ code: 'bot_question_invalid' }));
    }
  });

  it('reads back to the model as the prompt plus the offered replies', () => {
    expect(botQuestionContextText(normalizeBotQuestion({ prompt: 'Which one?', options: ['A', 'B'] })))
      .toBe('Which one?\n(Quick replies offered: A | B)');
    expect(botQuestionContextText(null)).toBe('');
  });
});
