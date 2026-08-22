const normalizeProviderRetryMessage = (value) => (
  typeof value === 'string'
    ? value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    : ''
);

const normalizeProviderRetryActionReason = (value) => (
  typeof value === 'string' ? value.trim().toLowerCase() : ''
);

const PROVIDER_USAGE_LIMIT_ACTION_REASONS = new Set([
  'free_tier_limit',
]);

export const PROVIDER_USAGE_LIMIT_FAILURE_KIND = 'provider_usage_limit';
export const PROVIDER_PROMPT_REJECTED_FAILURE_KIND = 'provider_prompt_rejected';
export const DEADLINE_EXCEEDED_FAILURE_KIND = 'deadline_exceeded';
export const MANAGED_TASK_TIMEOUT_REASON_PREFIX = 'Managed task timed out at ';
export const PROVIDER_TRANSPORT_FAILURE_KINDS = Object.freeze([
  'request_timeout',
  'response_header_timeout',
  'stream_idle_timeout',
  'connection_failure',
  'provider_queue_timeout',
]);

const normalizeTransportFailureText = (value) => {
  if (typeof value !== 'string') return '';
  let normalized = value.trim();
  if (
    normalized.length >= 2
    && normalized.startsWith('"')
    && normalized.endsWith('"')
  ) {
    try {
      const parsed = JSON.parse(normalized);
      if (typeof parsed === 'string') {
        normalized = parsed.trim();
      }
    } catch {
      // Keep malformed wrapped strings intact for best-effort classification.
    }
  }
  return normalized;
};

const NON_TRANSPORT_FAILURE_PATTERN = /\b(?:abort(?:ed)?|cancel(?:led|ed)?|authentication|authorization|unauthorized|forbidden|invalid api key|missing api key|oauth|access token|refresh token|credential|modelnotfound(?:error)?|model (?:is )?not found|unknown model|invalid model|no such model|certificate|self signed|unable to verify|x509)\b/i;
const NON_TRANSPORT_FAILURE_NAME_PATTERN = /(?:abort|cancel|auth|oauth|modelnotfound|certificate)/i;
const RESPONSE_HEADER_TIMEOUT_PATTERN = /(?:\bund_err_headers_timeout\b|\bheaders? timeout(?: error)?\b|\bresponse headers? (?:timed out|timeout)\b|\btimed out (?:while )?waiting for (?:the )?response headers?\b)/i;
const STREAM_IDLE_TIMEOUT_PATTERN = /(?:\bund_err_body_timeout\b|\bchunk timeout(?: error)?\b|\bstream idle timeout\b|\bupstream idle timeout exceeded\b|\bsse (?:read )?timed out\b|\btimed out (?:while )?waiting for (?:the )?(?:next )?(?:stream|chunk|response data)\b|\bno (?:stream )?data (?:was )?received\b)/i;
const REQUEST_TIMEOUT_PATTERN = /^(?:(?:unknown\s*error|unknownerror)\s*:\s*)?(?:(?:the )?(?:operation|request) (?:has )?timed out|request timeout(?:error)?|timeout(?:error)?)\.?$/i;
const CONNECTION_FAILURE_PATTERN = /(?:^terminated$|\beconn(?:aborted|refused|reset)\b|\behostunreach\b|\benet(?:down|unreach)\b|\benotfound\b|\bepipe\b|\betimedout\b|\bund_err_(?:connect_timeout|socket)\b|\bstreaming response failed\b|\bupstream request failed\b|\bpremature(?:ly)? close(?:d)?\b|\bsocket hang up\b|\bconnection (?:closed|dropped|failed|lost|refused|reset|terminated)\b|\bnetwork (?:connection )?(?:error|failure)\b|\bfetch failed\b)/i;

/**
 * Provider-side queue/capacity failures. These are transient — the same prompt
 * succeeds on retry — but they must be matched BEFORE
 * NON_TRANSPORT_FAILURE_PATTERN, because xAI phrases its queue timeout as
 * `Request <id> timed out in queue, abort.` and that trailing "abort" otherwise
 * short-circuits the classifier into treating the whole thing as fatal.
 * Observed live on 2026-08-21 (three occurrences, at 97k/59k/266k context, so
 * this is provider infrastructure and not a payload-size problem).
 */
const PROVIDER_QUEUE_FAILURE_PATTERN = /(?:\btimed out in queue\b|\bservice (?:is )?temporarily unavailable\b|\bthe model did not respond\b|\bmodel is overloaded\b|\bserver is overloaded\b|\bcapacity exceeded\b|\bno capacity available\b)/i;

export const classifyProviderTransportFailure = (name, detail) => {
  const normalizedName = normalizeTransportFailureText(name);
  const normalizedDetail = normalizeTransportFailureText(detail);
  const combined = [normalizedName, normalizedDetail].filter(Boolean).join(': ');
  const compactName = normalizedName.replace(/[^a-z0-9]+/gi, '');
  // Checked first: these strings can legitimately contain "abort"/"cancelled".
  if (combined && PROVIDER_QUEUE_FAILURE_PATTERN.test(combined)) {
    return 'provider_queue_timeout';
  }
  if (
    !combined
    || NON_TRANSPORT_FAILURE_NAME_PATTERN.test(compactName)
    || NON_TRANSPORT_FAILURE_PATTERN.test(combined)
  ) {
    return null;
  }
  if (RESPONSE_HEADER_TIMEOUT_PATTERN.test(combined)) {
    return 'response_header_timeout';
  }
  if (STREAM_IDLE_TIMEOUT_PATTERN.test(combined)) {
    return 'stream_idle_timeout';
  }
  if (
    REQUEST_TIMEOUT_PATTERN.test(normalizedDetail)
    || REQUEST_TIMEOUT_PATTERN.test(normalizedName)
  ) {
    return 'request_timeout';
  }
  if (CONNECTION_FAILURE_PATTERN.test(combined)) {
    return 'connection_failure';
  }
  return null;
};

export const classifyProviderRetryFailure = (value) => {
  const message = normalizeProviderRetryMessage(value);
  if (!message) return null;
  if (
    message.includes('invalid prompt')
    && message.includes('prompt')
    && message.includes('flagged')
    && (
      message.includes('usage policy')
      || message.includes('policy violation')
      || message.includes('violating policy')
    )
  ) {
    return PROVIDER_PROMPT_REJECTED_FAILURE_KIND;
  }
  return message.includes('out of usage')
    || message.includes('usage exceeded')
    || message.includes('usage limit')
    || message.includes('hit your limit')
    || message.includes('session limit')
    || message.includes('rate limit')
    || message.includes('rate limited')
    || message.includes('quota limit')
    || message.includes('quota exceeded')
    || message.includes('quota has been exceeded')
    || message.includes('insufficient quota')
    ? PROVIDER_USAGE_LIMIT_FAILURE_KIND
    : null;
};

export const classifyProviderRetryStatus = (value) => {
  const actionReason = normalizeProviderRetryActionReason(value?.action?.reason);
  if (PROVIDER_USAGE_LIMIT_ACTION_REASONS.has(actionReason)) {
    return PROVIDER_USAGE_LIMIT_FAILURE_KIND;
  }
  return classifyProviderRetryFailure(value?.message);
};

export const isDefiniteProviderUsageLimit = (value) => {
  return classifyProviderRetryFailure(value) === PROVIDER_USAGE_LIMIT_FAILURE_KIND;
};

export const isProviderPromptRejected = (value) => {
  return classifyProviderRetryFailure(value) === PROVIDER_PROMPT_REJECTED_FAILURE_KIND;
};

export const isManagedTaskDeadlineExceeded = (value) => (
  typeof value === 'string' && value.startsWith(MANAGED_TASK_TIMEOUT_REASON_PREFIX)
);

export const classifyManagedTaskFailure = (value) => (
  classifyProviderRetryFailure(value)
  ?? (isManagedTaskDeadlineExceeded(value) ? DEADLINE_EXCEEDED_FAILURE_KIND : null)
);
