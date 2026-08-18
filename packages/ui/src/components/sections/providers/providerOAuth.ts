export type ProviderOAuthMethod = 'auto' | 'code';

export type ProviderOAuthPhase = 'waiting' | 'loading-models' | 'models-pending' | 'error';

/**
 * Final state of an OAuth attempt.
 *
 * Only a failed callback may resolve to 'error'. Once the callback succeeds the credentials are
 * persisted upstream, so a model catalog that has not caught up yet is 'models-pending' — a
 * non-fatal state — never a failure. A `null` phase means the attempt is fully done.
 */
export const resolveProviderOAuthPhase = (input: {
  callbackError?: string | null;
  providerReady?: boolean;
}): { phase: ProviderOAuthPhase | null; error?: string } => {
  if (input.callbackError) {
    return { phase: 'error', error: input.callbackError };
  }
  return { phase: input.providerReady ? null : 'models-pending' };
};

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

export interface PostAuthConfigReloadResult {
  /** False when the reload could not be requested. Never fatal — credentials are already saved. */
  ok: boolean;
  /** True when the server deferred the restart until active chats finish. */
  deferred: boolean;
}

/**
 * Ask the server to re-apply configuration after credentials land, so OpenCode picks them up
 * instead of leaving the client to poll an unchanging catalog. Mirrors what the API-key path
 * gets via its config-mutation response. Never throws: the credentials are already persisted.
 */
export const requestPostAuthConfigReload = async ({
  fetchImpl = fetch,
}: { fetchImpl?: ProviderOAuthFetch } = {}): Promise<PostAuthConfigReloadResult> => {
  try {
    const response = await fetchImpl('/api/config/reload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!response.ok) return { ok: false, deferred: false };

    const payload = await response.json().catch(() => null);
    const data = unwrapPayload(payload);
    const applyStatus = isRecord(data.applyStatus) ? data.applyStatus : null;
    return { ok: true, deferred: applyStatus?.state === 'waiting_for_idle' };
  } catch {
    return { ok: false, deferred: false };
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
