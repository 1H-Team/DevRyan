import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./ModelControls.tsx', import.meta.url), 'utf8');

describe('ModelControls hidden-model fallback', () => {
  test('preserves the provider selected in settings while choosing a visible fallback model', () => {
    expect(source).toContain(`applyModelSelectionWithVariant(
            firstVisibleModelSelection.providerID,
            firstVisibleModelSelection.modelID,
            undefined,
            undefined,
            { preserveSelectedProvider: true },
        );`);
  });
});
