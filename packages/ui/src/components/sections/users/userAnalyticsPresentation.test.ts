import { describe, expect, test } from 'bun:test';

import { formatPromptModelLabel } from './userAnalyticsPresentation';

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
});
