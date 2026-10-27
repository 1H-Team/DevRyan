/**
 * Saved provider accounts (native credentials) for Settings → Providers. The
 * server serves metadata only (`GET /api/provider/:id/accounts`); switching,
 * renaming and removing go through the admitted `/api/credential/:id` routes.
 */

/** Providers whose native credentials DevRyan can list and manage. */
export const PROVIDER_ACCOUNT_PROVIDER_IDS = ['openai', 'xai', 'opencode', 'opencode-go', 'cursor-acp'] as const;

export type ProviderAccountMethod = 'key' | 'oauth' | 'external';

export interface ProviderAccount {
  id: string;
  label: string;
  method: ProviderAccountMethod;
  active: boolean;
  needsAuth: boolean;
}

export class ProviderAccountRequestError extends Error {
  constructor(message: string, readonly code: string | null, readonly status: number) {
    super(message);
    this.name = 'ProviderAccountRequestError';
  }
}

export const supportsProviderAccounts = (providerId: string): boolean => (
  PROVIDER_ACCOUNT_PROVIDER_IDS.some((id) => id === providerId)
);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,256}$/;
const toMethod = (value: unknown): ProviderAccountMethod | null => (
  value === 'key' || value === 'oauth' || value === 'external' ? value : null
);

/** Reads the server's account list; null when the payload is not one for this provider. */
export const parseProviderAccounts = (payload: unknown, providerId: string): ProviderAccount[] | null => {
  if (!isRecord(payload) || payload.providerID !== providerId || !Array.isArray(payload.accounts)) return null;
  const accounts: ProviderAccount[] = [];
  for (const item of payload.accounts) {
    if (!isRecord(item) || typeof item.id !== 'string' || !ACCOUNT_ID.test(item.id)) continue;
    const method = toMethod(item.method);
    if (!method) continue;
    accounts.push({
      id: item.id,
      label: typeof item.label === 'string' ? item.label : '',
      method,
      active: item.active === true,
      needsAuth: item.needsAuth === true,
    });
  }
  return accounts;
};

const readError = async (response: Response, fallback: string): Promise<ProviderAccountRequestError> => {
  const payload: unknown = await response.json().catch(() => null);
  const message = isRecord(payload) && typeof payload.error === 'string' && payload.error.trim() ? payload.error : fallback;
  const code = isRecord(payload) && typeof payload.code === 'string' ? payload.code : null;
  return new ProviderAccountRequestError(message, code, response.status);
};

const withDirectory = (path: string, directory: string | null | undefined): string => {
  const trimmed = directory?.trim();
  return trimmed ? `${path}?${new URLSearchParams({ directory: trimmed }).toString()}` : path;
};

/**
 * The provider's saved accounts, or null when this runtime cannot list them
 * (no native credential owner, or a provider it does not manage).
 */
export const fetchProviderAccounts = async (
  providerId: string,
  directory: string | null | undefined,
  { fetchImpl = globalThis.fetch, signal }: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<ProviderAccount[] | null> => {
  const response = await fetchImpl(withDirectory(`/api/provider/${encodeURIComponent(providerId)}/accounts`, directory), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (response.status === 404 || response.status === 501) return null;
  if (!response.ok) throw await readError(response, 'Failed to load provider accounts');
  const accounts = parseProviderAccounts(await response.json().catch(() => null), providerId);
  if (!accounts) throw new ProviderAccountRequestError('Invalid provider accounts response', null, response.status);
  return accounts;
};

type ProviderAccountMutation =
  | { operation: 'activate' }
  | { operation: 'rename'; label: string }
  | { operation: 'remove' };

export const mutateProviderAccount = async (
  accountId: string,
  mutation: ProviderAccountMutation,
  directory: string | null | undefined,
  { fetchImpl = globalThis.fetch }: { fetchImpl?: typeof fetch } = {},
): Promise<void> => {
  if (!ACCOUNT_ID.test(accountId)) throw new ProviderAccountRequestError('Invalid account', null, 400);
  const base = `/api/credential/${encodeURIComponent(accountId)}`;
  const request = mutation.operation === 'activate'
    ? { path: `${base}/activate`, method: 'POST', body: {} }
    : mutation.operation === 'rename'
      ? { path: base, method: 'PATCH', body: { label: mutation.label.trim().slice(0, 256) } }
      : { path: base, method: 'DELETE', body: undefined };
  const response = await fetchImpl(withDirectory(request.path, directory), {
    method: request.method,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-DevRyan-CSRF': '1' },
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
  });
  if (!response.ok) throw await readError(response, 'Failed to update provider account');
};
