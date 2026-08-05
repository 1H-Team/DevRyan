export const HUMAN_ACCOUNT_KIND = 'human';
export const AGENT_TEST_ACCOUNT_KIND = 'agent_test';

export function buildUserManagementProfileQuery(reviewerRole) {
  return {
    order: 'created_at.asc',
    account_kind: `eq.${HUMAN_ACCOUNT_KIND}`,
    ...(reviewerRole !== 'admin' ? { role: 'neq.admin' } : {}),
  };
}
