import { describe, expect, test } from 'bun:test';

import { HIDDEN_MODEL_REFS_LIMIT, sanitizeWebSettings } from './persistence';

describe('hidden model persistence', () => {
  test('keeps more than 64 distinct hidden refs across load, save and reload', () => {
    const hiddenModels = Array.from({ length: 150 }, (_, index) => ({ providerID: `p${index % 3}`, modelID: `m${index}` }));
    const loaded = sanitizeWebSettings({ hiddenModels });
    expect(loaded?.hiddenModels).toHaveLength(150);
    const next = [...(loaded?.hiddenModels ?? []), { providerID: 'p9', modelID: 'extra' }];
    expect(sanitizeWebSettings({ hiddenModels: next })?.hiddenModels).toHaveLength(151);
  });

  test('still bounds and de-duplicates hidden refs', () => {
    const duplicated = Array.from({ length: HIDDEN_MODEL_REFS_LIMIT + 10 }, (_, index) => ({ providerID: 'p', modelID: `m${index}` }));
    expect(sanitizeWebSettings({ hiddenModels: [...duplicated, ...duplicated] })?.hiddenModels).toHaveLength(HIDDEN_MODEL_REFS_LIMIT);
  });
});
