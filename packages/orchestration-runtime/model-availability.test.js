import { describe, expect, it } from 'vitest';

import { isManagedModelAvailableInCatalog } from './model-availability.js';

describe('managed model availability', () => {
  it('matches exact provider and model ids in object and array catalogs', () => {
    expect(isManagedModelAvailableInCatalog({
      providers: [{ id: 'openai', models: { 'gpt-5': { id: 'gpt-5' } } }],
    }, 'openai', 'gpt-5')).toBe(true);
    expect(isManagedModelAvailableInCatalog({
      data: { providers: [{ providerID: 'anthropic', models: [{ modelID: 'claude' }] }] },
    }, 'anthropic', 'claude')).toBe(true);
  });

  it('rejects exact missing and explicitly unavailable models', () => {
    const catalog = {
      providers: [{ id: 'openai', models: { 'gpt-5': { available: false } } }],
    };
    expect(isManagedModelAvailableInCatalog(catalog, 'openai', 'gpt-5')).toBe(false);
    expect(isManagedModelAvailableInCatalog(catalog, 'openai', 'gpt-4')).toBe(false);
    expect(isManagedModelAvailableInCatalog(catalog, 'anthropic', 'claude')).toBe(false);
  });

  it('returns unknown for malformed catalogs so transport failures remain tolerable', () => {
    expect(isManagedModelAvailableInCatalog(null, 'openai', 'gpt-5')).toBeNull();
    expect(isManagedModelAvailableInCatalog({ providers: [{ id: 'openai' }] }, 'openai', 'gpt-5')).toBeNull();
  });
});
