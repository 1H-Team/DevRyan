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

describe('ModelControls current model label', () => {
  test('resolves a hidden current model name from the unfiltered provider catalog', () => {
    expect(source).toContain('const catalogModel = currentProvider?.models.find((m: ProviderModel) => m.id === currentModelId);');
    expect(source).toContain('if (models.length === 0) return catalogModel ? getModelDisplayName(catalogModel) : currentModelId;');
    expect(source).toContain('const currentModel = models.find((m: ProviderModel) => m.id === currentModelId) ?? catalogModel;');
  });
});
