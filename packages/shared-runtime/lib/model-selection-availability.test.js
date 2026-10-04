import { expect, test } from 'bun:test';
import { inspectModelSelection } from './model-selection-availability.js';

test('availability preserves an exact effort and distinguishes incomplete from unsupported catalog evidence', () => {
  const selection = Object.freeze({ providerID: 'cursor-acp', modelID: 'composer-2.5', variant: 'high' });
  const catalog = { providers: [{ id: selection.providerID, models: [{ id: selection.modelID, variants: {} }] }] };
  expect(inspectModelSelection(selection, catalog, { variantsComplete: false })).toEqual({ status: 'unknown', reason: 'catalog_unavailable' });
  expect(inspectModelSelection(selection, catalog)).toEqual({ status: 'unavailable', reason: 'variant_missing' });
  catalog.providers[0].models[0].variants.high = {};
  expect(inspectModelSelection(selection, catalog)).toEqual({ status: 'available', reason: null });
  expect(selection.variant).toBe('high');
});

test('empty, malformed, unavailable and native array catalogs retain distinct evidence', () => {
  const selection = { providerID: 'owned', modelID: 'model', variant: 'high' };
  expect(inspectModelSelection(selection, null).status).toBe('unknown');
  expect(inspectModelSelection(selection, { providers: [] })).toEqual({ status: 'unavailable', reason: 'provider_missing' });
  expect(inspectModelSelection(selection, { providers: [{ id: 'owned', models: { model: { variants: [{ id: 'high' }] } } }] }).status).toBe('available');
  expect(inspectModelSelection(selection, { providers: [{ id: 'owned', models: { model: { available: false } } }] }).reason).toBe('model_missing');
  expect(inspectModelSelection({ ...selection, variant: null }, { providers: [{ id: 'owned', models: { model: {} } }] }).status).toBe('available');
});
