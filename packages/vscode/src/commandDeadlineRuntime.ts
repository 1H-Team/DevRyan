import {
  createCommandDeadlineController,
  type CommandDeadlineController,
  type CommandDeadlineRecord,
  type RecordStore,
} from '@openchamber/harness-runtime';

import type { OpenCodeManager } from './opencode';

type CommandDeadlineRuntimeOptions = {
  store: RecordStore<CommandDeadlineRecord>;
  manager: OpenCodeManager;
  publishEvent(event: unknown): void;
  recordIncident?(incident: Record<string, unknown>): void;
  sanitizeError?(error: string): string;
  fetchImpl?: typeof fetch;
  controllerOptions?: {
    now?: () => number;
    setTimeout?: typeof setTimeout;
    clearTimeout?: typeof clearTimeout;
    wait?: (milliseconds: number) => Promise<void>;
    graceMs?: number;
    confirmationMs?: number;
    confirmationPollMs?: number;
  };
};

const requestJson = async (
  manager: OpenCodeManager,
  fetchImpl: typeof fetch,
  pathname: string,
  directory: string,
  options: { method?: 'GET' | 'POST'; allowNotFound?: boolean } = {},
): Promise<unknown> => {
  const apiUrl = manager.getApiUrl();
  if (!apiUrl) throw new Error('OpenCode API URL is unavailable');
  const target = new URL(pathname, apiUrl);
  target.searchParams.set('directory', directory);
  const response = await fetchImpl(target, {
    method: options.method ?? 'GET',
    headers: { Accept: 'application/json', ...manager.getOpenCodeAuthHeaders() },
    signal: AbortSignal.timeout(5_000),
  });
  if (options.allowNotFound && response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`OpenCode ${options.method ?? 'GET'} ${pathname} responded with ${response.status}`);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
};

export const createVsCodeCommandDeadlineRuntime = (
  options: CommandDeadlineRuntimeOptions,
): CommandDeadlineController => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const { manager } = options;
  return createCommandDeadlineController({
    store: options.store,
    async fetchMessage(input) {
      return requestJson(
        manager,
        fetchImpl,
        `/session/${encodeURIComponent(input.sessionID)}/message/${encodeURIComponent(input.messageID)}`,
        input.directory,
        { allowNotFound: true },
      );
    },
    async abortSession(input) {
      await requestJson(
        manager,
        fetchImpl,
        `/session/${encodeURIComponent(input.sessionID)}/abort`,
        input.directory,
        { method: 'POST' },
      );
    },
    async listActiveSessions(input) {
      const statuses = await requestJson(
        manager,
        fetchImpl,
        '/session/status',
        input.directory,
      );
      if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) {
        throw new Error('OpenCode session status returned an invalid payload');
      }
      return Object.entries(statuses)
        .filter(([, status]) => (
          status
          && typeof status === 'object'
          && typeof (status as { type?: unknown }).type === 'string'
          && (status as { type: string }).type !== 'idle'
        ))
        .map(([sessionID]) => sessionID);
    },
    restartManagedRuntime: () => manager.restart({ force: true }),
    isExternalRuntime: () => manager.getDebugInfo().mode === 'external',
    publishPart({ record, part }) {
      options.publishEvent({
        type: 'message.part.updated',
        properties: {
          sessionID: record.fingerprint.sessionID,
          messageID: record.fingerprint.messageID,
          part,
        },
      });
    },
    recordIncident: options.recordIncident,
    sanitizeError: options.sanitizeError,
    ...options.controllerOptions,
  });
};
