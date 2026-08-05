export type AgentTestRole = 'developer' | 'admin';

export interface AgentTestIdentity {
  role: AgentTestRole;
  label: string;
}

export type SessionAuthErrorCode = 'identity_unavailable' | 'schema_migration_required';

export interface SessionStatusShape {
  code?: SessionAuthErrorCode;
  retryAfter?: number;
}

export type SessionStatusDecision =
  | { state: 'authenticated' }
  | { state: 'locked' }
  | { state: 'rate-limited'; retryAfter?: number }
  | { state: 'identity-unavailable' }
  | { state: 'schema-migration-required' }
  | { state: 'server-error' };

export const classifySessionResponse = (
  status: number,
  ok: boolean,
  payload: SessionStatusShape,
): SessionStatusDecision => {
  if (ok) return { state: 'authenticated' };
  if (status === 401) return { state: 'locked' };
  if (status === 429) return { state: 'rate-limited', retryAfter: payload.retryAfter };
  if (status === 503 && payload.code === 'schema_migration_required') {
    return { state: 'schema-migration-required' };
  }
  if (status === 503 && payload.code === 'identity_unavailable') {
    return { state: 'identity-unavailable' };
  }
  return { state: 'server-error' };
};

export const orderAgentTestIdentities = (value: unknown): AgentTestIdentity[] => {
  if (!Array.isArray(value)) return [];
  const identities = value.filter((item): item is AgentTestIdentity => {
    if (!item || typeof item !== 'object') return false;
    const candidate = item as Partial<AgentTestIdentity>;
    return (candidate.role === 'developer' || candidate.role === 'admin')
      && typeof candidate.label === 'string'
      && candidate.label.trim().length > 0;
  });
  return (['developer', 'admin'] as const).flatMap((role) => {
    const matches = identities.filter((identity) => identity.role === role);
    return matches.length === 1 ? [matches[0]] : [];
  });
};

export const localResetSucceeded = (ok: boolean, payload: unknown): boolean => {
  if (ok) return true;
  return Boolean(
    payload
    && typeof payload === 'object'
    && (payload as { localSessionCleared?: boolean }).localSessionCleared === true,
  );
};

const PRINCIPAL_SCOPED_ROUTE_PARAMS = ['session', 'tab', 'settings', 'file'] as const;

/**
 * Account changes must not carry route state owned by the previous principal.
 * Preserve unrelated query parameters and the hash so host-level links keep
 * working, while returning the app itself to its safe default route.
 */
export const buildPrincipalTransitionPath = (href: string): string => {
  const url = new URL(href, 'http://127.0.0.1');
  for (const key of PRINCIPAL_SCOPED_ROUTE_PARAMS) {
    url.searchParams.delete(key);
  }
  const search = url.searchParams.toString();
  return `${url.pathname}${search ? `?${search}` : ''}${url.hash}`;
};
