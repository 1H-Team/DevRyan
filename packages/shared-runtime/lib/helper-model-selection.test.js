import { test, expect } from 'bun:test';
import { DEFAULT_HELPER_MODEL_SELECTION, parseHelperModelSelection } from './helper-model-selection.js';

test('helper settings carry one exact model revision with provider Default reasoning', () => {
  expect(DEFAULT_HELPER_MODEL_SELECTION).toEqual({ providerID: 'opencode', modelID: 'deepseek-v4.1-flash', revision: 'default' });
  const chosen = { providerID: 'cursor-acp', modelID: 'selected', revision: 'revision-2' };
  expect(parseHelperModelSelection(chosen)).toEqual(chosen);
  for (const extra of [{ variant: 'low' }, { tools: [] }, { prompt: 'untrusted' }, { revision: '' }, { modelID: 'with space' }]) {
    expect(parseHelperModelSelection({ ...chosen, ...extra })).toBeUndefined();
  }
});
