import { describe, expect, it } from 'vitest';

import {
  AGENT_TEST_ACCOUNT_KIND,
  HUMAN_ACCOUNT_KIND,
  buildUserManagementProfileQuery,
} from './user-profile-visibility.js';

describe('managed user profile visibility', () => {
  it('uses explicit account kinds for human and AI-agent test identities', () => {
    expect(HUMAN_ACCOUNT_KIND).toBe('human');
    expect(AGENT_TEST_ACCOUNT_KIND).toBe('agent_test');
  });

  it('keeps AI-agent test identities out of administrator user management', () => {
    expect(buildUserManagementProfileQuery('admin')).toEqual({
      order: 'created_at.asc',
      account_kind: 'eq.human',
    });
  });

  it('preserves the senior-developer role restriction alongside account visibility', () => {
    expect(buildUserManagementProfileQuery('senior_developer')).toEqual({
      order: 'created_at.asc',
      account_kind: 'eq.human',
      role: 'neq.admin',
    });
  });
});
