import type { BridgeContext, BridgeResponse } from './bridge';
import { waitForApiUrl } from './opencode-ready';
import { readAuthFile } from './opencodeAuth';
import { annotateOpenAIModelAvailability } from './openaiModelAvailability';
import { getVsCodeHarnessRuntime } from './harness-runtime-access';

type BridgeMessageInput = {
  id: string;
  type: string;
  payload?: unknown;
};

type ApiProxyRequestPayload = {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  bodyBase64?: string;
};

type ApiSessionMessageRequestPayload = {
  path?: string;
  headers?: Record<string, string>;
  bodyText?: string;
};

type ApiProxyResponsePayload = {
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
};

type ProxyRuntimeDeps = {
  tryHandleLocalFsProxy: (method: string, requestPath: string) => Promise<ApiProxyResponsePayload | null>;
  buildUnavailableApiResponse: () => ApiProxyResponsePayload;
  sanitizeForwardHeaders: (input: Record<string, string> | undefined) => Record<string, string>;
  collectHeaders: (headers: Headers) => Record<string, string>;
  base64EncodeUtf8: (text: string) => string;
  getCachedCursorProvider: () => Record<string, unknown> | null;
  refreshCursorProvider: () => Promise<void>;
};

const sortFingerprintValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortFingerprintValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortFingerprintValue(entry)]),
  );
};

const cursorProviderFingerprint = (provider: Record<string, unknown> | null): string => {
  try {
    return JSON.stringify(sortFingerprintValue(provider));
  } catch {
    return '';
  }
};

const scheduleCursorProviderRefresh = (
  ctx: BridgeContext | undefined,
  deps: ProxyRuntimeDeps,
): void => {
  let previousFingerprint = '';
  try {
    previousFingerprint = cursorProviderFingerprint(deps.getCachedCursorProvider());
  } catch {
    // A failed cache read must not block the upstream provider response.
  }

  try {
    void deps.refreshCursorProvider()
      .then(() => {
        let nextFingerprint = previousFingerprint;
        try {
          nextFingerprint = cursorProviderFingerprint(deps.getCachedCursorProvider());
        } catch {
          return;
        }
        if (!nextFingerprint || nextFingerprint === previousFingerprint) return;
        setTimeout(() => {
          void ctx?.postMessage?.({ type: 'command', command: 'providersChanged' });
        }, 0);
      })
      .catch(() => {
        // Discovery is best-effort and will retry on the next managed catalog request.
      });
  } catch {
    // Preserve the cached provider if refresh scheduling fails synchronously.
  }
};

const mergeCachedCursorProvider = (
  payload: Record<string, unknown>,
  provider: Record<string, unknown> | null,
): Record<string, unknown> => {
  if (!provider) return payload;
  const providers = Array.isArray(payload.providers) ? payload.providers : [];
  return {
    ...payload,
    providers: [
      ...providers.filter((entry) => (
        !entry || typeof entry !== 'object' || (entry as { id?: unknown }).id !== 'cursor-acp'
      )),
      provider,
    ],
  };
};

const decodeJsonBody = (value: string | undefined, encoding: 'base64' | 'text'): unknown => {
  if (!value) return null;
  try {
    const text = encoding === 'base64' ? Buffer.from(value, 'base64').toString('utf8') : value;
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const promptPathDetails = (requestPath: string): {
  sessionID: string;
  directory: string | undefined;
} | null => {
  const parsed = new URL(requestPath, 'https://openchamber.invalid');
  const match = parsed.pathname.match(/^\/session\/([^/]+)\/(?:prompt|prompt_async|message)$/);
  if (!match) return null;
  return {
    sessionID: decodeURIComponent(match[1]),
    directory: parsed.searchParams.get('directory') || undefined,
  };
};

const getPromptMessageID = (body: unknown): string | undefined => {
  if (!body || typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;
  const value = record.messageID ?? record.messageId ?? record.id;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

const unavailableHarnessResponse = (
  deps: ProxyRuntimeDeps,
  block?: { code: string; error: string; retryAfterSeconds: number } | null,
): ApiProxyResponsePayload => ({
  status: 503,
  headers: {
    'content-type': 'application/json',
    'retry-after': String(block?.retryAfterSeconds ?? 1),
  },
  bodyBase64: deps.base64EncodeUtf8(JSON.stringify({
    error: block?.error ?? 'DevRyan harness is initializing or shutting down',
    code: block?.code ?? 'HARNESS_NOT_ACCEPTING_PROMPTS',
  })),
});

const admitPrompt = (
  requestPath: string,
  body: unknown,
  deps: ProxyRuntimeDeps,
): ApiProxyResponsePayload | null => {
  const details = promptPathDetails(requestPath);
  if (!details) return null;
  const runtime = getVsCodeHarnessRuntime();
  if (!runtime) return unavailableHarnessResponse(deps);
  const admissionBlock = runtime.getPromptAdmissionBlock();
  if (admissionBlock) return unavailableHarnessResponse(deps, admissionBlock);
  runtime.recordPrompt({
    ...details,
    messageID: getPromptMessageID(body),
    path: requestPath,
    body,
  });
  return null;
};

const recordSessionControl = (
  method: string,
  requestPath: string,
  body: unknown,
): void => {
  if (method === 'GET' || method === 'HEAD') return;
  const parsed = new URL(requestPath, 'https://openchamber.invalid');
  const match = parsed.pathname.match(/^\/session\/([^/]+)\/(abort|revert|fork|share|unshare)$/);
  if (!match) return;
  getVsCodeHarnessRuntime()?.recordControl({
    sessionID: decodeURIComponent(match[1]),
    action: match[2],
    directory: parsed.searchParams.get('directory') || undefined,
    path: requestPath,
    body,
  });
};

export async function handleProxyBridgeMessage(
  message: BridgeMessageInput,
  ctx: BridgeContext | undefined,
  deps: ProxyRuntimeDeps,
): Promise<BridgeResponse | null> {
  const { id, type, payload } = message;

  switch (type) {
    case 'api:proxy': {
      const { method, path: requestPath, headers, bodyBase64 } = (payload || {}) as ApiProxyRequestPayload;
      const normalizedMethod = typeof method === 'string' && method.trim() ? method.trim().toUpperCase() : 'GET';
      const normalizedPath =
        typeof requestPath === 'string' && requestPath.trim().length > 0
          ? requestPath.trim().startsWith('/')
            ? requestPath.trim()
            : `/${requestPath.trim()}`
          : '/';

      const localFsResponse = await deps.tryHandleLocalFsProxy(normalizedMethod, normalizedPath);
      if (localFsResponse) {
        return { id, type, success: true, data: localFsResponse };
      }
      const decodedBody = normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD'
        ? decodeJsonBody(bodyBase64, 'base64')
        : null;
      if (normalizedMethod === 'POST') {
        const admissionFailure = admitPrompt(
          normalizedPath,
          decodedBody,
          deps,
        );
        if (admissionFailure) {
          return { id, type, success: true, data: admissionFailure };
        }
      }
      recordSessionControl(normalizedMethod, normalizedPath, decodedBody);

      const apiUrl = await waitForApiUrl(ctx?.manager);
      if (!apiUrl) {
        const data = deps.buildUnavailableApiResponse();
        return { id, type, success: true, data };
      }

      const base = `${apiUrl.replace(/\/+$/, '')}/`;
      const targetUrl = new URL(normalizedPath.replace(/^\/+/, ''), base).toString();
      const requestHeaders: Record<string, string> = {
        ...deps.sanitizeForwardHeaders(headers),
        ...ctx?.manager?.getOpenCodeAuthHeaders(),
      };

      if (normalizedPath === '/event' || normalizedPath === '/global/event') {
        if (!requestHeaders.Accept) {
          requestHeaders.Accept = 'text/event-stream';
        }
        requestHeaders['Cache-Control'] = requestHeaders['Cache-Control'] || 'no-cache';
        requestHeaders.Connection = requestHeaders.Connection || 'keep-alive';
      }

      try {
        const response = await fetch(targetUrl, {
          method: normalizedMethod,
          headers: requestHeaders,
          body:
            typeof bodyBase64 === 'string' && bodyBase64.length > 0 && normalizedMethod !== 'GET' && normalizedMethod !== 'HEAD'
              ? Buffer.from(bodyBase64, 'base64')
              : undefined,
        });

        let arrayBuffer = await response.arrayBuffer();
        if (
          response.ok
          && normalizedMethod === 'GET'
          && normalizedPath.split('?')[0] === '/config/providers'
          && ctx?.manager?.getDebugInfo?.().mode !== 'external'
        ) {
          try {
            const payload = JSON.parse(Buffer.from(arrayBuffer).toString('utf8')) as Record<string, unknown>;
            let nextPayload = payload;
            try {
              const auth = readAuthFile();
              nextPayload = annotateOpenAIModelAvailability(nextPayload, auth.openai);
            } catch {
              // Cursor metadata remains independently mergeable if auth lookup fails.
            }
            scheduleCursorProviderRefresh(ctx, deps);
            try {
              nextPayload = mergeCachedCursorProvider(nextPayload, deps.getCachedCursorProvider());
            } catch {
              // Keep other managed-provider annotations if the Cursor cache is unavailable.
            }
            arrayBuffer = Buffer.from(JSON.stringify(nextPayload));
          } catch {
            // Preserve the upstream provider response if parsing or serialization fails.
          }
        }
        const data: ApiProxyResponsePayload = {
          status: response.status,
          headers: deps.collectHeaders(response.headers),
          bodyBase64: Buffer.from(arrayBuffer).toString('base64'),
        };
        if (response.ok && normalizedMethod === 'POST') {
          const details = promptPathDetails(normalizedPath);
          if (details) {
            getVsCodeHarnessRuntime()?.lifecycle.recordPromptAccepted({
              ...details,
              messageID: getPromptMessageID(decodedBody),
            });
          }
        }

        return { id, type, success: true, data };
      } catch (error) {
        const body = JSON.stringify({
          error: error instanceof Error ? error.message : 'Failed to reach OpenCode API',
        });
        const data: ApiProxyResponsePayload = {
          status: 502,
          headers: { 'content-type': 'application/json' },
          bodyBase64: deps.base64EncodeUtf8(body),
        };
        return { id, type, success: true, data };
      }
    }

    case 'api:session:message': {
      const apiUrl = await waitForApiUrl(ctx?.manager);
      if (!apiUrl) {
        const data = deps.buildUnavailableApiResponse();
        return { id, type, success: true, data };
      }

      const { path: requestPath, headers, bodyText } = (payload || {}) as ApiSessionMessageRequestPayload;
      const normalizedPath =
        typeof requestPath === 'string' && requestPath.trim().length > 0
          ? requestPath.trim().startsWith('/')
            ? requestPath.trim()
            : `/${requestPath.trim()}`
          : '/';

      if (!/^\/session\/[^/]+\/message(?:\?.*)?$/.test(normalizedPath)) {
        const body = JSON.stringify({ error: 'Invalid session message proxy path' });
        const data: ApiProxyResponsePayload = {
          status: 400,
          headers: { 'content-type': 'application/json' },
          bodyBase64: deps.base64EncodeUtf8(body),
        };
        return { id, type, success: true, data };
      }
      const admissionFailure = admitPrompt(
        normalizedPath,
        decodeJsonBody(bodyText, 'text'),
        deps,
      );
      if (admissionFailure) {
        return { id, type, success: true, data: admissionFailure };
      }

      const base = `${apiUrl.replace(/\/+$/, '')}/`;
      const targetUrl = new URL(normalizedPath.replace(/^\/+/, ''), base).toString();
      const requestHeaders: Record<string, string> = {
        ...deps.sanitizeForwardHeaders(headers),
        ...ctx?.manager?.getOpenCodeAuthHeaders(),
      };

      try {
        const response = await fetch(targetUrl, {
          method: 'POST',
          headers: requestHeaders,
          body: typeof bodyText === 'string' ? bodyText : '',
          signal: AbortSignal.timeout(45000),
        });

        const arrayBuffer = await response.arrayBuffer();
        const data: ApiProxyResponsePayload = {
          status: response.status,
          headers: deps.collectHeaders(response.headers),
          bodyBase64: Buffer.from(arrayBuffer).toString('base64'),
        };
        if (response.ok) {
          const details = promptPathDetails(normalizedPath);
          if (details) {
            getVsCodeHarnessRuntime()?.lifecycle.recordPromptAccepted({
              ...details,
              messageID: getPromptMessageID(decodeJsonBody(bodyText, 'text')),
            });
          }
        }

        return { id, type, success: true, data };
      } catch (error) {
        const isTimeout =
          error instanceof Error &&
          ((error as Error & { name?: string }).name === 'TimeoutError' ||
            (error as Error & { name?: string }).name === 'AbortError');
        const body = JSON.stringify({
          error: isTimeout ? 'OpenCode message forward timed out' : error instanceof Error ? error.message : 'OpenCode message forward failed',
        });
        const data: ApiProxyResponsePayload = {
          status: isTimeout ? 504 : 503,
          headers: { 'content-type': 'application/json' },
          bodyBase64: deps.base64EncodeUtf8(body),
        };
        return { id, type, success: true, data };
      }
    }

    default:
      return null;
  }
}
