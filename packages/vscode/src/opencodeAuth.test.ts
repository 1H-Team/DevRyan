import { describe, expect, it } from 'vitest';

import { getProviderAuthLookupIds } from './opencodeAuth';

describe('VS Code provider auth aliases', () => {
  it('removes both Google credential keys through the canonical lookup set', () => {
    expect(getProviderAuthLookupIds('google')).toEqual(['google', 'google.oauth']);
  });

  it('does not widen unrelated provider IDs', () => {
    expect(getProviderAuthLookupIds('openai')).toEqual(['openai']);
  });
});
