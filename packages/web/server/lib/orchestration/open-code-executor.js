import {
  createManagedOpenCodeExecutor,
} from '@openchamber/orchestration-runtime';
import { CURSOR_PROVIDER_ID } from '@openchamber/cursor-sdk-runtime';

import { stripMessageDiffSummary } from '../opencode/diff-summary.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
// Session transcripts are unbounded: OpenCode attaches a full git diff snapshot
// to user messages, which for a repo with a large untracked tree can reach tens
// of megabytes. Reading one is not a fast control-plane call and must not share
// the 10s budget used by status/prompt/abort — a transcript that cannot be read
// inside the budget used to stall the managed task until its hard deadline.
const DEFAULT_MESSAGES_REQUEST_TIMEOUT_MS = 120_000;
const MAX_ERROR_BODY_LENGTH = 2_000;

const appendDirectory = (pathname, directory, extra = {}) => {
  const query = new URLSearchParams(extra);
  if (typeof directory === 'string' && directory.trim()) {
    query.set('directory', directory.trim());
  }
  const serialized = query.toString();
  return serialized ? `${pathname}?${serialized}` : pathname;
};

const unwrapPayload = (value) => (
  value && typeof value === 'object' && !Array.isArray(value) && 'data' in value
    ? value.data
    : value
);

const createHttpError = async (response, label) => {
  const body = (await response.text().catch(() => '')).slice(0, MAX_ERROR_BODY_LENGTH).trim();
  const error = new Error(
    `${label} failed (${response.status})${body ? `: ${body}` : ''}`,
  );
  error.code = 'opencode_http_error';
  error.statusCode = response.status;
  return error;
};

export const createWebManagedOpenCodeExecutor = (options = {}) => {
  if (typeof options.buildOpenCodeUrl !== 'function') {
    throw new TypeError('buildOpenCodeUrl is required');
  }
  if (typeof options.getOpenCodeAuthHeaders !== 'function') {
    throw new TypeError('getOpenCodeAuthHeaders is required');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const messagesRequestTimeoutMs = options.messagesRequestTimeoutMs
    ?? DEFAULT_MESSAGES_REQUEST_TIMEOUT_MS;
  const cursorSdkRuntime = options.cursorSdkRuntime ?? null;

  const requestJson = async (pathname, requestOptions = {}) => {
    const response = await fetchImpl(options.buildOpenCodeUrl(pathname, ''), {
      method: requestOptions.method ?? 'GET',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...options.getOpenCodeAuthHeaders(),
      },
      ...(requestOptions.body === undefined
        ? {}
        : { body: JSON.stringify(requestOptions.body) }),
      signal: requestOptions.signal
        ?? AbortSignal.timeout(requestOptions.timeoutMs ?? requestTimeoutMs),
    });
    if (requestOptions.allowNotFound && response.status === 404) return null;
    if (!response.ok) throw await createHttpError(response, requestOptions.label ?? 'OpenCode request');
    if (response.status === 204) return null;
    const text = await response.text();
    if (!text.trim()) return null;
    try {
      return unwrapPayload(JSON.parse(text));
    } catch {
      const error = new Error(`${requestOptions.label ?? 'OpenCode request'} returned invalid JSON`);
      error.code = 'opencode_invalid_response';
      error.statusCode = 502;
      throw error;
    }
  };

  const buildPromptBody = (input) => ({
    ...(input.messageId ? { messageID: input.messageId } : {}),
    agent: input.agent,
    model: {
      providerID: input.providerId,
      modelID: input.modelId,
    },
    ...(input.variant ? { variant: input.variant } : {}),
    ...(input.tools ? { tools: input.tools } : {}),
    parts: [{ type: 'text', text: input.prompt }],
  });

  const transport = {
    async createSession(input) {
      return await requestJson(appendDirectory('/session', input.directory), {
        method: 'POST',
        label: 'session.create',
        body: {
          title: input.title,
          ...(input.parentSessionId ? { parentID: input.parentSessionId } : {}),
        },
      });
    },
    async promptSession(input) {
      const body = buildPromptBody(input);
      if (input.providerId === CURSOR_PROVIDER_ID) {
        if (!cursorSdkRuntime || typeof cursorSdkRuntime.handlePromptAsync !== 'function') {
          const error = new Error('Cursor managed orchestration is unavailable in this runtime');
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
          const error = new Error(
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
        {
          method: 'POST',
          label: 'session.prompt_async',
          body,
        },
      );
    },
    async readSession(input) {
      return await requestJson(
        appendDirectory(`/session/${encodeURIComponent(input.sessionId)}`, input.directory),
        {
          allowNotFound: true,
          label: 'session.get',
        },
      );
    },
    async readStatus(input) {
      if (input.providerId === CURSOR_PROVIDER_ID) {
        const statuses = cursorSdkRuntime && typeof cursorSdkRuntime.getSessionStatus === 'function'
          ? cursorSdkRuntime.getSessionStatus()
          : {};
        return statuses?.[input.sessionId] ?? null;
      }
      const statuses = await requestJson(appendDirectory('/session/status', input.directory), {
        label: 'session.status',
      });
      return statuses?.[input.sessionId] ?? null;
    },
    async readMessages(input) {
      if (input.providerId === CURSOR_PROVIDER_ID) {
        if (!cursorSdkRuntime || typeof cursorSdkRuntime.getSessionMessages !== 'function') return [];
        return await cursorSdkRuntime.getSessionMessages(input.sessionId);
      }
      const messages = await requestJson(
        appendDirectory(`/session/${encodeURIComponent(input.sessionId)}/message`, input.directory, {
          limit: '100',
        }),
        { label: 'session.messages', timeoutMs: messagesRequestTimeoutMs },
      );
      // Drop the diff snapshot immediately. Managed observation only reads
      // role/id/error/finish/time and parts, while `summary.diffs` carries the
      // bulk of the payload and would otherwise be retained for the whole poll.
      return Array.isArray(messages) ? messages.map(stripMessageDiffSummary) : [];
    },
    async abortSession(input) {
      if (input.providerId === CURSOR_PROVIDER_ID) {
        if (!cursorSdkRuntime || typeof cursorSdkRuntime.abortSession !== 'function') return false;
        return await cursorSdkRuntime.abortSession(input.sessionId);
      }
      await requestJson(
        appendDirectory(`/session/${encodeURIComponent(input.sessionId)}/abort`, input.directory),
        {
          method: 'POST',
          label: 'session.abort',
          signal: input.signal,
        },
      );
      return true;
    },
    async deleteSession(input) {
      const failures = [];
      if (
        input.providerId === CURSOR_PROVIDER_ID
        && cursorSdkRuntime
        && typeof cursorSdkRuntime.deleteSessionState === 'function'
      ) {
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
