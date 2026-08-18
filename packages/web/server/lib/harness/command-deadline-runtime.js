import { createCommandDeadlineController } from '@openchamber/harness-runtime';

const requestJson = async ({
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  fetchImpl,
  pathname,
  directory,
  method = 'GET',
  allowNotFound = false,
}) => {
  const target = new URL(buildOpenCodeUrl(pathname));
  target.searchParams.set('directory', directory);
  const response = await fetchImpl(target, {
    method,
    headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
    signal: AbortSignal.timeout(5_000),
  });
  if (allowNotFound && response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`OpenCode ${method} ${pathname} responded with ${response.status}`);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
};

export const createWebCommandDeadlineRuntime = (options = {}) => {
  const {
    store,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    publishEvent,
    restartOpenCode,
    isExternalOpenCode,
  } = options;
  if (typeof buildOpenCodeUrl !== 'function') throw new TypeError('buildOpenCodeUrl is required');
  if (typeof getOpenCodeAuthHeaders !== 'function') {
    throw new TypeError('getOpenCodeAuthHeaders is required');
  }
  const fetchImpl = options.fetchImpl ?? fetch;

  return createCommandDeadlineController({
    store,
    async fetchMessage(input) {
      return requestJson({
        buildOpenCodeUrl,
        getOpenCodeAuthHeaders,
        fetchImpl,
        pathname: `/session/${encodeURIComponent(input.sessionID)}/message/${encodeURIComponent(input.messageID)}`,
        directory: input.directory,
        allowNotFound: true,
      });
    },
    async abortSession(input) {
      await requestJson({
        buildOpenCodeUrl,
        getOpenCodeAuthHeaders,
        fetchImpl,
        pathname: `/session/${encodeURIComponent(input.sessionID)}/abort`,
        directory: input.directory,
        method: 'POST',
      });
    },
    async listActiveSessions(input) {
      const statuses = await requestJson({
        buildOpenCodeUrl,
        getOpenCodeAuthHeaders,
        fetchImpl,
        pathname: '/session/status',
        directory: input.directory,
      });
      if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)) {
        throw new Error('OpenCode session status returned an invalid payload');
      }
      return Object.entries(statuses)
        .filter(([, status]) => (
          status
          && typeof status === 'object'
          && typeof status.type === 'string'
          && status.type !== 'idle'
        ))
        .map(([sessionID]) => sessionID);
    },
    restartManagedRuntime: () => restartOpenCode(),
    isExternalRuntime: () => isExternalOpenCode(),
    publishPart({ record, part }) {
      publishEvent({
        type: 'message.part.updated',
        properties: {
          sessionID: record.fingerprint.sessionID,
          messageID: record.fingerprint.messageID,
          part,
        },
      }, { directory: record.directory });
    },
    recordIncident: options.recordIncident,
    sanitizeError: options.sanitizeError,
    ...options.controllerOptions,
  });
};
