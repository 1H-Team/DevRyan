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

const FETCH_CAUSE_CODE = /^[A-Z][A-Z0-9_]{1,39}$/;

// Content-free log projection for any failure reaching a Bot log line. DOM
// timeouts carry a numeric `code` (23) that is truthy, so `error.code || fallback`
// printed bare numbers; Supabase request failures carry only a status. Every
// field here is a stable identifier, never a message or payload.
export const botErrorLogFields = (error, fallbackCode = 'bot_error') => {
  const name = typeof error?.name === 'string' && stableCode(error.name) ? error.name : null;
  const status = Number.isInteger(error?.statusCode)
    ? error.statusCode
    : (Number.isInteger(error?.status) ? error.status : null);
  const existing = stableCode(error?.code);
  let code = existing;
  if (name === 'TimeoutError' || error?.code === 23) code = 'request_timeout';
  else if (name === 'AbortError') code = 'request_aborted';
  else if (!code && name === 'SupabaseRequestError') code = `supabase_${status ?? 'request'}`;
  else if (!code && typeof error?.cause?.code === 'string' && FETCH_CAUSE_CODE.test(error.cause.code)) {
    code = error.cause.code.toLowerCase();
  } else if (!code) code = stableCode(fallbackCode) || 'bot_error';
  return Object.freeze({
    code,
    ...(name ? { name } : {}),
    ...(status !== null ? { status } : {}),
  });
};

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
