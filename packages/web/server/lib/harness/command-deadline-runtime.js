import { resolveGen2OpenCodeClient } from '../opencode/opencode-client-seam.js';
import { createCommandDeadlineController } from '@devryan/harness-runtime';

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
  const controller = createCommandDeadlineController({
    store,
    cancelCommand: typeof options.cancelCommand === 'function'
      ? (input) => options.cancelCommand(input, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      : undefined,
    async fetchMessage(input) {
      return resolveGen2OpenCodeClient(openCodeClient).sessions.message(input.sessionID, input.messageID, {
        directory: input.directory, allowNotFound: true, timeoutMs: REQUEST_TIMEOUT_MS,
      });
    },
    async abortSession(input) {
      await resolveGen2OpenCodeClient(openCodeClient).sessions.abort(input.sessionID, { directory: input.directory, timeoutMs: REQUEST_TIMEOUT_MS });
    },
    async listActiveSessions() {
      // Restart affects the whole native host, including other project locations.
      return activeSessionIDs(await resolveGen2OpenCodeClient(openCodeClient).sessions.status({}, { timeoutMs: REQUEST_TIMEOUT_MS }));
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
  return {
    ...controller,
    // From the execution host's shell-job binding: the projected part identity
    // the controller also observes, the real start and the enforced timeout.
    registerShellJob: (input) => controller.register({
      fingerprint: { sessionID: input.sessionID, messageID: input.messageID, partID: input.partID, callID: input.callID, tool: input.tool },
      directory: input.directory,
      startedAt: input.startedAt,
      requestedTimeoutMs: input.requestedTimeoutMs,
      effectiveTimeoutMs: input.effectiveTimeoutMs,
    }),
  };
};
