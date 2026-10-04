import { resolveGen2OpenCodeClient } from '../opencode/opencode-client-seam.js';
import { createCommandDeadlineController } from '@openchamber/harness-runtime';

const REQUEST_TIMEOUT_MS = 5_000;

/** The non-idle session ids of a v1 status map. */
const activeSessionIDs = (statuses) => {
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
};

export const createWebCommandDeadlineRuntime = (options = {}) => {
  const {
    store,
    publishEvent,
    restartOpenCode,
    isExternalOpenCode,
  } = options;
  const openCodeClient = options.openCodeClient ?? null;
  if (openCodeClient !== null && typeof openCodeClient?.generation !== 'function') {
    throw new TypeError('openCodeClient must be an openCodeClient');
  }
  return createCommandDeadlineController({
    store,
    async fetchMessage(input) {
      return resolveGen2OpenCodeClient(openCodeClient).sessions.message(input.sessionID, input.messageID, {
        directory: input.directory, allowNotFound: true, timeoutMs: REQUEST_TIMEOUT_MS,
      });
    },
    async abortSession(input) {
      await resolveGen2OpenCodeClient(openCodeClient).sessions.abort(input.sessionID, { directory: input.directory, timeoutMs: REQUEST_TIMEOUT_MS });
    },
    async listActiveSessions(input) {
      return activeSessionIDs(await resolveGen2OpenCodeClient(openCodeClient).sessions.status({ directory: input.directory }, { timeoutMs: REQUEST_TIMEOUT_MS }));
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
