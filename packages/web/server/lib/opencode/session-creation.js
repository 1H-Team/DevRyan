import { randomUUID } from 'node:crypto';

export const SESSION_CREATE_RESTART_REJECTED = 'session_create_restart_rejected';
export const SESSION_CREATE_OUTCOME_UNKNOWN = 'session_create_outcome_unknown';
export const isSessionCreateRequest = (req) => req.method === 'POST'
  && /^\/(?:api\/)?session\/?$/.test(String(req.originalUrl || req.url || '').split('?')[0]);
export const creationUnknownPayload = () => ({
  error: 'Session creation outcome is unknown. A session may already exist; do not automatically retry.',
  code: SESSION_CREATE_OUTCOME_UNKNOWN,
  retryable: false,
});
export const creationRestartPayload = () => ({
  error: 'OpenCode is restarting', code: SESSION_CREATE_RESTART_REJECTED, restarting: true, retryable: true,
});
export const creationNotDispatchedPayload = () => ({
  error: 'Session creation deadline elapsed before dispatch. Your draft is retained.',
  code: 'session_create_not_dispatched', retryable: false,
});

export function beginSessionCreationTrace(req, record = () => {}) {
  if (req.sessionCreationTrace) return req.sessionCreationTrace;
  const suppliedId = req.headers?.['x-devryan-creation-attempt'];
  const attemptId = typeof suppliedId === 'string' && /^[a-f0-9-]{36}$/i.test(suppliedId) ? suppliedId : randomUUID();
  const startedAt = Date.now();
  const suppliedBudget = Number(req.headers?.['x-devryan-creation-budget-ms']);
  const budgetMs = Number.isFinite(suppliedBudget) && suppliedBudget > 0 ? Math.min(120_000, suppliedBudget) : 120_000;
  const trace = {
    attemptId,
    remainingMs: () => Math.max(0, budgetMs - (Date.now() - startedAt)),
    mark(mark, sessionId) {
      // No URLs, directories, prompt content, attachments, models or credentials.
      try { record({ type: 'timing', mark: `session.creation.${mark}`, sessionID: sessionId || null,
        payload: { operationID: attemptId, durationMs: Date.now() - startedAt } }); }
      catch { /* Diagnostics cannot change mutation semantics. */ }
    },
  };
  req.sessionCreationTrace = trace;
  trace.mark('request_received');
  return trace;
}
