import { describe, expect, test } from 'bun:test';

import { parseProviderFormFields, providerFormAnswer, providerFormComplete } from './ProviderMethodFields';

// GitHub Copilot's sign-in form as the native runtime sends it.
const copilot = parseProviderFormFields([
  { key: 'deploymentType', type: 'string', title: 'Select GitHub deployment type', required: true,
    options: [{ value: 'github.com', label: 'GitHub.com' }, { value: 'enterprise', label: 'GitHub Enterprise' }] },
  { key: 'enterpriseUrl', type: 'string', required: true, when: [{ key: 'deploymentType', op: 'eq', value: 'enterprise' }] },
]);

describe('provider method fields', () => {
  test('follow conditions when deciding what is required and sent', () => {
    expect(copilot).toHaveLength(2);
    expect(providerFormComplete(copilot, {})).toBe(false);
    expect(providerFormComplete(copilot, { deploymentType: 'github.com' })).toBe(true);
    // A hidden field's stale value is never sent.
    expect(providerFormAnswer(copilot, { deploymentType: 'github.com', enterpriseUrl: 'old.ghe.com' })).toEqual({ deploymentType: 'github.com' });
    expect(providerFormComplete(copilot, { deploymentType: 'enterprise', enterpriseUrl: '  ' })).toBe(false);
    expect(providerFormAnswer(copilot, { deploymentType: 'enterprise', enterpriseUrl: ' co.ghe.com ' })).toEqual({ deploymentType: 'enterprise', enterpriseUrl: 'co.ghe.com' });
  });

  test('methods without a form send no answer and malformed forms are dropped', () => {
    expect(providerFormAnswer([], {})).toBeUndefined();
    expect(providerFormComplete([], {})).toBe(true);
    expect(parseProviderFormFields([{ key: 'count', type: 'number' }])).toEqual([]);
    expect(parseProviderFormFields([{ key: 'kind', type: 'string', options: [{ value: 1 }] }])).toEqual([]);
    expect(parseProviderFormFields('not a form')).toEqual([]);
  });
});
