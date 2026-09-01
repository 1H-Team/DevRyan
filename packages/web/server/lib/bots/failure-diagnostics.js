import { homedir } from 'node:os';
import { createDiagnosticSanitizer } from '@openchamber/harness-runtime';

const sanitizer = createDiagnosticSanitizer({ homeDir: homedir() });
const safeIdentifier = (value) => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(value) ? value : null;
const sanitizeErrorText = (value) => sanitizer.sanitizeText(value.slice(0, 4096)
  .replace(/\b(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)\b["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
    '[REDACTED]:credential')).slice(0, 1024);

// No response bodies, headers, stack traces, tool arguments, or credentials.
// The host journal applies its deployment-specific sanitizer a second time.
export const createBotFailureRecorder = (recordDiagnostic = () => {}) => ({
  event, run, sessionId = null, operationId = null, stage, error, reason = null, statusCode = null,
}) => {
  const data = error?.data && typeof error.data === 'object' ? error.data : {};
  const rawMessage = typeof data.message === 'string' ? data.message
    : (typeof error?.message === 'string' ? error.message : '');
  const status = data.statusCode ?? error?.statusCode ?? error?.status ?? statusCode;
  try {
    recordDiagnostic(sanitizer.sanitizeRecord({
      type: 'lifecycle', event, sessionID: safeIdentifier(sessionId),
      payload: {
        runId: safeIdentifier(run?.id || run?.runId),
        botId: safeIdentifier(run?.bot_id || run?.botId),
        channelId: safeIdentifier(run?.channel_id || run?.channelId),
        operationId: safeIdentifier(operationId),
        stage,
        error: {
          name: safeIdentifier(error?.name), code: safeIdentifier(error?.code),
          statusCode: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
          message: sanitizeErrorText(rawMessage),
          ref: safeIdentifier(data.requestID || data.requestId || data.providerRequestId
            || data.metadata?.requestID || data.metadata?.requestId),
          retry: typeof data.isRetryable === 'boolean' ? data.isRetryable : null,
          reason: safeIdentifier(reason || error?.diagnostics?.reason || error?.remoteCode),
          stage: safeIdentifier(error?.diagnostics?.stage),
        },
      },
    }));
  } catch {
    // Recording must never replace the original failure or prevent cleanup.
  }
};
