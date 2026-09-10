import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { botErrorLogFields } from './error-normalization.js';

// One trace spans the SSE route, snapshot preparation, and the response's
// lifetime. Only fixed stage names and content-free measurements reach disk.
export const createBotEventDiagnostics = (recordDiagnostic = () => {}) => {
  const subscriptionId = randomUUID();
  const startedAt = performance.now();
  let stage = 'request';
  let snapshotBytes = null;
  let failed = false;
  const record = (event, fields = {}) => {
    try {
      recordDiagnostic({
        type: 'connection',
        event: `bot.events.${event}`,
        payload: {
          subscriptionId,
          stage,
          elapsedMs: Math.round(performance.now() - startedAt),
          ...(snapshotBytes === null ? {} : { snapshotBytes }),
          ...fields,
        },
      });
    } catch {
      // Diagnostics must not change connection behavior.
    }
  };
  return Object.freeze({
    stage(value) { stage = value; },
    snapshot(bytes) { snapshotBytes = bytes; },
    record,
    failure(error, statusCode = 500) {
      if (failed) return;
      failed = true;
      const fields = botErrorLogFields(error, 'bot_event_connection_failed');
      record('failed', {
        ...fields,
        statusCode: Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599 ? statusCode : 500,
      });
    },
  });
};
