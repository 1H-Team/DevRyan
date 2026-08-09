import { describe, expect, test } from 'bun:test';

import { formatPromptModelLabel, formatPromptRowSummary } from './userAnalyticsPresentation';

describe('user analytics prompt presentation', () => {
  test('shows the recorded provider and model identifiers together', () => {
    expect(formatPromptModelLabel('openai', 'gpt-5')).toBe('openai/gpt-5');
  });

  test('shows a recorded model when provider metadata is unavailable', () => {
    expect(formatPromptModelLabel('', 'gpt-5')).toBe('gpt-5');
  });

  test('marks legacy prompts without model metadata as unavailable', () => {
    expect(formatPromptModelLabel('', '')).toBe('Model unavailable');
  });

  test('uses the first meaningful line as the title and later lines as the preview', () => {
    expect(formatPromptRowSummary('\n  Build the settings row  \n\n Show all metadata\nKeep the time right  ')).toEqual({
      title: 'Build the settings row',
      preview: 'Show all metadata Keep the time right',
    });
  });

  test('does not duplicate a single-line prompt as its preview', () => {
    expect(formatPromptRowSummary('Fix the prompt styling')).toEqual({
      title: 'Fix the prompt styling',
      preview: null,
    });
  });

  test('uses the attachment-only fallback when prompt text is blank', () => {
    expect(formatPromptRowSummary(' \n\t\n ')).toEqual({
      title: '(Attachment-only prompt)',
      preview: null,
    });
  });

  test('keeps long title and preview content intact for CSS clamping', () => {
    const title = 'Title '.repeat(80).trim();
    const preview = 'Preview '.repeat(100).trim();
    expect(formatPromptRowSummary(`${title}\n${preview}`)).toEqual({ title, preview });
  });
});
