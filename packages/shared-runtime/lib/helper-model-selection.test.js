import { test, expect } from 'bun:test';
import { DEFAULT_HELPER_MODEL_SELECTION, parseHelperModelSelection } from './helper-model-selection.js';

test('helper settings carry one exact model revision; Default reasoning has no variant', () => {
  expect(DEFAULT_HELPER_MODEL_SELECTION).toEqual({ providerID: 'opencode', modelID: 'deepseek-v4.1-flash', revision: 'default' });
  expect(Object.hasOwn(DEFAULT_HELPER_MODEL_SELECTION, 'variant')).toBe(false);
  const chosen = { providerID: 'cursor-acp', modelID: 'selected', revision: 'revision-2' };
  expect(parseHelperModelSelection(chosen)).toEqual(chosen);
  expect(Object.hasOwn(parseHelperModelSelection(chosen), 'variant')).toBe(false);
  for (const extra of [{ tools: [] }, { prompt: 'untrusted' }, { revision: '' }, { modelID: 'with space' },
    { variant: '' }, { variant: 'with space' }, { variant: null }, { variant: 3 }, { variant: 'x'.repeat(257) }]) {
    expect(parseHelperModelSelection({ ...chosen, ...extra })).toBeUndefined();
  }
});

test('helper settings keep an explicit reasoning variant exactly', () => {
  const chosen = { providerID: 'openai', modelID: 'gpt-6-astra', variant: 'low', revision: 'revision-3' };
  expect(parseHelperModelSelection(chosen)).toEqual(chosen);
  expect(parseHelperModelSelection({ ...chosen, variant: undefined })).toEqual({ providerID: 'openai', modelID: 'gpt-6-astra', revision: 'revision-3' });
});
