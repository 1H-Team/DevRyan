import { CURSOR_PROVIDER_ID } from '@openchamber/cursor-sdk-runtime';
import {
  createKeyedSingleFlight,
  createManagedOpenCodeExecutor,
  type ManagedOpenCodeTransport,
  type ManagedTaskExecutor,
} from '@openchamber/orchestration-runtime';

import type { OpenCodeManager } from './opencode';

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_ERROR_BODY_LENGTH = 2_000;

type RuntimeError = Error & { code?: string; statusCode?: number };
type ManagedOpenCodeStatus = NonNullable<Awaited<ReturnType<ManagedOpenCodeTransport['readStatus']>>>;

export type VsCodeCursorSdkRuntimeAdapter = {
  handlePromptAsync(input: {
    sessionID: string;
    directory: string;
    body: Record<string, unknown>;
  }): Promise<{ handled?: boolean; status?: number; body?: { error?: string } | null }>;
  getSessionStatus(): Record<string, ManagedOpenCodeStatus>;
  getSessionMessages(sessionId: string): Promise<Array<{
    info?: Record<string, unknown>;
    parts?: Record<string, unknown>[];
  }>>;
  abortSession(sessionId: string): Promise<boolean>;
  deleteSessionState?(sessionId: string): Promise<boolean>;
};

export type VsCodeManagedOpenCodeManagerAdapter = Pick<
  OpenCodeManager,
  'getApiUrl' | 'getOpenCodeAuthHeaders'
> & {
  getDebugInfo?: OpenCodeManager['getDebugInfo'];
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const appendDirectory = (pathname: string, directory: string, extra: Record<string, string> = {}) => {
  const query = new URLSearchParams(extra);
  if (directory.trim()) query.set('directory', directory.trim());
  const serialized = query.toString();
  return serialized ? `${pathname}?${serialized}` : pathname;
};

const unwrapPayload = (value: unknown) => (
  isRecord(value) && 'data' in value ? value.data : value
);

export const createVsCodeManagedOpenCodeExecutor = (options: {
  manager: VsCodeManagedOpenCodeManagerAdapter;
  cursorSdkRuntime?: VsCodeCursorSdkRuntimeAdapter | null;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
  idleStablePolls?: number;
  sleep?: (delayMs: number, options: { signal: AbortSignal }) => Promise<void>;
}): ManagedTaskExecutor => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const cursorSdkRuntime = options.cursorSdkRuntime ?? null;
  const statusSingleFlight = createKeyedSingleFlight();

  const resolveRequestUrl = (pathname: string) => {
    const baseUrl = options.manager.getApiUrl();
    if (!baseUrl) {
      const error: RuntimeError = new Error('OpenCode API URL is unavailable');
      error.code = 'managed_runtime_unavailable';
      error.statusCode = 503;
      throw error;
    }
    return new URL(pathname, `${baseUrl.replace(/\/+$/, '')}/`);
  };

  const requestJsonUrl = async (
    url: URL,
    requestOptions: {
      method?: string;
      body?: unknown;
      label?: string;
      allowNotFound?: boolean;
      signal?: AbortSignal;
    } = {},
  ) => {
    const response = await fetchImpl(url, {
      method: requestOptions.method ?? 'GET',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...options.manager.getOpenCodeAuthHeaders(),
      },
      ...(requestOptions.body === undefined ? {} : { body: JSON.stringify(requestOptions.body) }),
      signal: requestOptions.signal ?? AbortSignal.timeout(requestTimeoutMs),
    });
    if (requestOptions.allowNotFound && response.status === 404) return null;
    if (!response.ok) {
      const body = (await response.text().catch(() => '')).slice(0, MAX_ERROR_BODY_LENGTH).trim();
      const error: RuntimeError = new Error(
        `${requestOptions.label ?? 'OpenCode request'} failed (${response.status})${body ? `: ${body}` : ''}`,
      );
      error.code = 'opencode_http_error';
      error.statusCode = response.status;
      throw error;
    }
    if (response.status === 204) return null;
    const text = await response.text();
    if (!text.trim()) return null;
    try {
      return unwrapPayload(JSON.parse(text));
    } catch {
      const error: RuntimeError = new Error(`${requestOptions.label ?? 'OpenCode request'} returned invalid JSON`);
      error.code = 'opencode_invalid_response';
      error.statusCode = 502;
      throw error;
    }
  };

  const requestJson = async (
    pathname: string,
    requestOptions: {
      method?: string;
      body?: unknown;
      label?: string;
      allowNotFound?: boolean;
      signal?: AbortSignal;
    } = {},
  ) => await requestJsonUrl(resolveRequestUrl(pathname), requestOptions);

  const transport: ManagedOpenCodeTransport = {
    async createSession(input) {
      const result = await requestJson(appendDirectory('/session', input.directory), {
        method: 'POST',
        label: 'session.create',
        body: {
          title: input.title,
          ...(input.parentSessionId ? { parentID: input.parentSessionId } : {}),
        },
      });
      return isRecord(result) ? result : null;
    },
    async promptSession(input) {
      const body = {
        ...(input.messageId ? { messageID: input.messageId } : {}),
        agent: input.agent,
        model: { providerID: input.providerId, modelID: input.modelId },
        ...(input.variant ? { variant: input.variant } : {}),
        ...(input.tools ? { tools: input.tools } : {}),
        parts: [{ type: 'text', text: input.prompt }],
      };
      if (input.providerId === CURSOR_PROVIDER_ID) {
        if (!cursorSdkRuntime) {
          const error: RuntimeError = new Error('Cursor managed orchestration is unavailable in this runtime');
          error.code = 'cursor_runtime_unavailable';
          error.statusCode = 503;
          throw error;
        }
        const result = await cursorSdkRuntime.handlePromptAsync({
          sessionID: input.sessionId,
          directory: input.directory,
          body,
        });
        const status = result?.status ?? 200;
        if (!result?.handled || status < 200 || status >= 300) {
          const error: RuntimeError = new Error(
            typeof result?.body?.error === 'string'
              ? result.body.error
              : 'Cursor did not accept the managed prompt',
          );
          error.code = 'cursor_prompt_rejected';
          error.statusCode = status >= 400 && status <= 599 ? status : 502;
          throw error;
        }
        return;
      }
      await requestJson(
        appendDirectory(`/session/${encodeURIComponent(input.sessionId)}/prompt_async`, input.directory),
        { method: 'POST', label: 'session.prompt_async', body },
      );
    },
    async readSession(input) {
      const result = await requestJson(
        appendDirectory(`/session/${encodeURIComponent(input.sessionId)}`, input.directory),
        { allowNotFound: true, label: 'session.get' },
      );
      return isRecord(result) ? result : null;
    },
    async readStatus(input) {
      if (input.providerId === CURSOR_PROVIDER_ID) {
        return cursorSdkRuntime?.getSessionStatus()?.[input.sessionId] ?? null;
      }
      const statusUrl = resolveRequestUrl(appendDirectory('/session/status', input.directory));
      const result = await statusSingleFlight.run(statusUrl.toString(), async () => (
        await requestJsonUrl(statusUrl, { label: 'session.status' })
      ));
      return isRecord(result) && isRecord(result[input.sessionId])
        ? result[input.sessionId] as ManagedOpenCodeStatus
        : null;
    },
    async readMessages(input) {
      if (input.providerId === CURSOR_PROVIDER_ID) {
        return cursorSdkRuntime ? await cursorSdkRuntime.getSessionMessages(input.sessionId) : [];
      }
      const result = await requestJson(
        appendDirectory(`/session/${encodeURIComponent(input.sessionId)}/message`, input.directory, { limit: '100' }),
        { label: 'session.messages' },
      );
      return Array.isArray(result) ? result : [];
    },
    async abortSession(input) {
      if (input.providerId === CURSOR_PROVIDER_ID) {
        return cursorSdkRuntime ? await cursorSdkRuntime.abortSession(input.sessionId) : false;
      }
      await requestJson(
        appendDirectory(`/session/${encodeURIComponent(input.sessionId)}/abort`, input.directory),
        { method: 'POST', label: 'session.abort', signal: input.signal },
      );
      return true;
    },
    async deleteSession(input) {
      const failures: Error[] = [];
      if (input.providerId === CURSOR_PROVIDER_ID && cursorSdkRuntime?.deleteSessionState) {
        try {
          await cursorSdkRuntime.deleteSessionState(input.sessionId);
        } catch (error) {
          failures.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
      try {
        await requestJson(
          appendDirectory(`/session/${encodeURIComponent(input.sessionId)}`, input.directory),
          {
            method: 'DELETE',
            allowNotFound: true,
            label: 'session.delete',
          },
        );
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, `Failed to delete managed child ${input.sessionId}`);
      }
      return true;
    },
  };

  return createManagedOpenCodeExecutor({
    transport,
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.idleStablePolls === undefined ? {} : { idleStablePolls: options.idleStablePolls }),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
};
