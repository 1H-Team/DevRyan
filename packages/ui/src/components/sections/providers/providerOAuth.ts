export type ProviderOAuthMethod = 'auto' | 'code';

export interface ProviderOAuthAuthorization {
  method: ProviderOAuthMethod;
  url?: string;
  instructions?: string;
  userCode?: string;
}

export interface ProviderOAuthFetchResponse {
  ok: boolean;
  json: () => Promise<unknown>;
}

export type ProviderOAuthFetch = (
  input: string,
  init: RequestInit,
) => Promise<ProviderOAuthFetchResponse>;

interface ProviderCatalogEntry {
  id?: unknown;
  models?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const unwrapPayload = (payload: unknown): Record<string, unknown> => {
  if (!isRecord(payload)) return {};
  return isRecord(payload.data) ? payload.data : payload;
};

const firstNonEmptyString = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
};

export const parseProviderOAuthAuthorization = (
  payload: unknown,
): ProviderOAuthAuthorization | null => {
  const data = unwrapPayload(payload);
  const method = data.method === 'auto' || data.method === 'code'
    ? data.method
    : 'code';
  const url = firstNonEmptyString(
    data.url,
    data.verification_uri_complete,
    data.verification_uri,
  );
  const instructions = firstNonEmptyString(data.instructions, data.message);
  const userCode = firstNonEmptyString(data.user_code, data.code, data.userCode);

  if (!url && !instructions && !userCode) return null;
  return { method, url, instructions, userCode };
};

export const getProviderOAuthErrorMessage = (
  payload: unknown,
  fallback: string,
): string => {
  if (!isRecord(payload)) return fallback;
  const direct = firstNonEmptyString(payload.error, payload.message);
  if (direct) return direct;
  const data = isRecord(payload.data) ? payload.data : null;
  return firstNonEmptyString(data?.message) ?? fallback;
};

export const requestProviderOAuthCallback = async ({
  providerId,
  methodIndex,
  code,
  fallbackError,
  fetchImpl = fetch,
}: {
  providerId: string;
  methodIndex: number;
  code?: string;
  fallbackError: string;
  fetchImpl?: ProviderOAuthFetch;
}): Promise<void> => {
  const normalizedCode = code?.trim();
  const body: { method: number; code?: string } = { method: methodIndex };
  if (normalizedCode) body.code = normalizedCode;

  const response = await fetchImpl(
    `/api/provider/${encodeURIComponent(providerId)}/oauth/callback`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(getProviderOAuthErrorMessage(payload, fallbackError));
  }
};

export const providerCatalogHasModels = (
  providers: readonly ProviderCatalogEntry[] | null | undefined,
  providerId: string,
): boolean => providers?.some((provider) => (
  provider.id === providerId
  && Array.isArray(provider.models)
  && provider.models.length > 0
)) === true;
