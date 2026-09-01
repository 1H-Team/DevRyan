const BOT_ERROR_CODE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;

const stableCode = (value) => typeof value === 'string' && BOT_ERROR_CODE.test(value)
  ? value
  : null;

const boundedStage = (value) => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/.test(value) ? value : null;

export class NormalizedBotRunError extends Error {
  constructor(message, code, statusCode, diagnostics = null, runtimeStage = null) {
    super(message);
    this.name = 'NormalizedBotRunError';
    this.code = code;
    this.statusCode = statusCode;
    this.diagnostics = diagnostics ? Object.freeze({ ...diagnostics }) : null;
    if (runtimeStage) {
      Object.defineProperty(this, 'botRuntimeStage', {
        configurable: true,
        enumerable: false,
        value: runtimeStage,
      });
    }
  }
}

export const normalizeBotRunError = (error, { cancellationConfirmed = false } = {}) => {
  const existingCode = stableCode(error?.code);
  const runtimeStage = boundedStage(error?.botRuntimeStage || error?.diagnostics?.stage);
  if (cancellationConfirmed) {
    return new NormalizedBotRunError(
      'Bot run was cancelled',
      'bot_run_cancelled',
      499,
      { ...(error?.diagnostics || {}), retryable: false },
      runtimeStage,
    );
  }
  if (existingCode) return error;

  const name = typeof error?.name === 'string' ? error.name : '';
  if (name === 'TimeoutError' || error?.code === 23) {
    return new NormalizedBotRunError(
      'Bot agent request timed out',
      'bot_opencode_request_timeout',
      504,
      { ...(error?.diagnostics || {}), normalizedFrom: 'TimeoutError' },
      runtimeStage,
    );
  }
  if (name === 'AbortError') {
    return new NormalizedBotRunError(
      'Bot agent request was aborted',
      'bot_opencode_request_aborted',
      503,
      { ...(error?.diagnostics || {}), normalizedFrom: 'AbortError' },
      runtimeStage,
    );
  }
  return new NormalizedBotRunError(
    'Bot agent run failed',
    'bot_agent_run_failed',
    Number.isInteger(error?.statusCode) ? error.statusCode : 502,
    { ...(error?.diagnostics || {}), normalizedFrom: stableCode(name) || 'Error' },
    runtimeStage,
  );
};
