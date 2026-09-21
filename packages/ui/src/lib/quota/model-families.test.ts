import { describe, expect, test } from 'bun:test';

import { getDefaultModels, getUsageModelDisplayInfo } from './model-families';

describe('quota model display info', () => {
  test('uses usage metadata when rendering Antigravity model rows', () => {
    expect(getUsageModelDisplayInfo('antigravity/gemini-3-flash', {
      displayName: 'Gemini 3 Flash',
      contextLabel: '1M',
    })).toEqual({
      displayName: 'Gemini 3 Flash',
      contextLabel: '1M',
    });
  });

  test('falls back to scoped model display names when metadata is unavailable', () => {
    expect(getUsageModelDisplayInfo('antigravity/gemini-3-flash', {})).toEqual({
      displayName: 'gemini-3-flash',
      contextLabel: null,
    });
  });
});

test('Gemini 3 and dotted 3.x match without catching other model generations', () => {
  expect(getDefaultModels('google', ['gemini-3-pro', 'gemini/gemini-3.1-pro', 'antigravity/GEMINI-3.2-flash',
    'gemini-30-pro', 'gemini-2.5-pro', 'gemini-3x-pro', 'not-gemini-3.1-pro', 'claude-sonnet-4'])).toEqual([
    'gemini-3-pro', 'gemini/gemini-3.1-pro', 'antigravity/GEMINI-3.2-flash', 'claude-sonnet-4',
  ]);
});
