import { describe, expect, it } from 'vitest';

import { inspectManagedModelInCatalog, isManagedModelAvailableInCatalog, projectManagedModelValidationFailure } from './model-availability.js';

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

it('validates the exact variant without replacing a saved effort with provider default', () => {
  const catalog = { providers: [{ id: 'openai', models: { model: { variants: { medium: {} } } } }] };
  expect(isManagedModelAvailableInCatalog(catalog, 'openai', 'model', 'medium')).toBe(true);
  expect(isManagedModelAvailableInCatalog(catalog, 'openai', 'model', 'high')).toBe(false);
  expect(isManagedModelAvailableInCatalog(catalog, 'openai', 'model', null)).toBe(true);
  expect(isManagedModelAvailableInCatalog(null, 'openai', 'model', 'high')).toBeNull();
});

it('retains the exact catalog refusal reason alongside the compatibility boolean', () => {
  const catalog = { providers: [{ id: 'opencode-go', models: { flash: { variants: { low: {}, high: {}, max: {} } } } }] };
  expect(inspectManagedModelInCatalog(catalog, 'opencode-go', 'flash', 'medium'))
    .toEqual({ status: 'unavailable', reason: 'variant_missing', supportedVariants: ['low', 'high', 'max'] });
  expect(inspectManagedModelInCatalog(catalog, 'missing', 'flash')).toEqual({ status: 'unavailable', reason: 'provider_missing' });
  expect(inspectManagedModelInCatalog(catalog, 'opencode-go', 'missing')).toEqual({ status: 'unavailable', reason: 'model_missing' });
  expect(inspectManagedModelInCatalog(null, 'opencode-go', 'flash')).toEqual({ status: 'unknown', reason: 'catalog_unavailable' });
});

it('projects only bounded model refusal details and constructs the tool message without foreign error text', () => {
  const projected = projectManagedModelValidationFailure({ code: 'managed_agent_model_unavailable', message: 'private error text',
    details: { reason: 'variant_missing', providerId: 'opencode-go', modelId: 'flash', variant: 'medium', token: 'private token' } });
  expect(projected.details).toEqual({ reason: 'variant_missing', providerId: 'opencode-go', modelId: 'flash', variant: 'medium' });
  expect(projected.message).toContain('or Provider default in Agents settings');
  expect(JSON.stringify(projected)).not.toContain('private');
  expect(projectManagedModelValidationFailure({ code: 'other_error', details: projected.details })).toBeNull();
  expect(projectManagedModelValidationFailure({ code: projected.code, details: { reason: 'foreign_reason' } })).toBeNull();
  const bounded = projectManagedModelValidationFailure({ code: projected.code,
    details: { ...projected.details, modelId: 'x'.repeat(400), variant: 'medium\u0000\n' } });
  expect(bounded.details.modelId).toHaveLength(180);
  expect(bounded.details.variant).toBe('medium');
  const named = projectManagedModelValidationFailure({ code: projected.code, details: { ...projected.details,
    agent: 'Explorer\u0000', modelName: 'DeepSeek Flash\n', supportedVariants: ['low', 'high', 'max', 'low', null, ''] } });
  expect(named.details).toMatchObject({ agent: 'Explorer', modelName: 'DeepSeek Flash', supportedVariants: ['low', 'high', 'max'] });
  expect(named.message).toBe('Explorer cannot start: medium is unsupported for DeepSeek Flash. Choose low, high, max or Provider default in Agents settings.');
  expect(projectManagedModelValidationFailure({ code: projected.code, details: { ...projected.details,
    supportedVariants: Array.from({ length: 30 }, (_, index) => `variant-${index}`) } }).details.supportedVariants).toHaveLength(16);
});
