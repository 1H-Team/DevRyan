import { describe, expect, it } from 'vitest';
import { projectBotAssistantResponse } from './opencode-provider.js';
import { sanitizeBotConversationalText, sanitizeBotConversationalTextParts } from './response-sanitizer.js';

describe('Bot typed response boundary', () => {
  it.each([
    'Checking the account is required before payment.',
    '**Planning a trip**\nHere are the dates.',
    'Using TypeScript\nThe types are checked.',
    'Crafting a strong pricing prompt takes a clear audience.',
    '<analysis>Literal example requested by the user.</analysis>',
    '```tool_call\n{"name":"example"}\n```',
    'تحليل النتائج: هذه هي الإجابة',
    '正在分析数据的方法',
    'C',
  ])('preserves legitimate final text without guessing from language: %s', (text) => {
    expect(sanitizeBotConversationalText(text)).toBe(text);
  });

  it('excludes reasoning, unknown, hidden and synthetic parts using authoritative metadata', () => {
    expect(sanitizeBotConversationalTextParts([
      { type: 'reasoning', text: 'Private reasoning' },
      { type: 'unknown', text: 'Unclassified delta' },
      { type: 'text', text: 'Hidden', visible: false },
      { type: 'text', text: 'Ignored', ignored: true },
      { type: 'text', text: 'Context', synthetic: true },
      { type: 'text', text: 'The answer.' },
    ])).toBe('The answer.');
  });

  it('projects only final text after the last authoritative tool boundary', () => {
    expect(projectBotAssistantResponse([
      { type: 'text', text: 'I will check.' },
      { type: 'tool' },
      { type: 'text', text: 'Still checking.' },
      { type: 'tool' },
      { type: 'reasoning', text: 'Analyzing internal response' },
      { type: 'text', text: 'The requested result.' },
    ])).toEqual({
      toolObserved: true,
      acknowledgmentText: 'I will check.',
      resultText: 'The requested result.',
      resultFallback: false,
      generatedImages: [],
    });
  });
});
