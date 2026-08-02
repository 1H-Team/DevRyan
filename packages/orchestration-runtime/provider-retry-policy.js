const normalizeProviderRetryMessage = (value) => (
  typeof value === 'string'
    ? value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    : ''
);

export const PROVIDER_USAGE_LIMIT_FAILURE_KIND = 'provider_usage_limit';
export const PROVIDER_TRANSPORT_FAILURE_KINDS = Object.freeze([
  'request_timeout',
  'response_header_timeout',
  'stream_idle_timeout',
  'connection_failure',
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
const STREAM_IDLE_TIMEOUT_PATTERN = /(?:\bund_err_body_timeout\b|\bchunk timeout(?: error)?\b|\bstream idle timeout\b|\bsse (?:read )?timed out\b|\btimed out (?:while )?waiting for (?:the )?(?:next )?(?:stream|chunk|response data)\b|\bno (?:stream )?data (?:was )?received\b)/i;
const REQUEST_TIMEOUT_PATTERN = /^(?:(?:unknown\s*error|unknownerror)\s*:\s*)?(?:(?:the )?(?:operation|request) (?:has )?timed out|request timeout(?:error)?|timeout(?:error)?)\.?$/i;
const CONNECTION_FAILURE_PATTERN = /(?:^terminated$|\beconn(?:aborted|refused|reset)\b|\behostunreach\b|\benet(?:down|unreach)\b|\benotfound\b|\bepipe\b|\betimedout\b|\bund_err_(?:connect_timeout|socket)\b|\bstreaming response failed\b|\bupstream request failed\b|\bpremature(?:ly)? close(?:d)?\b|\bsocket hang up\b|\bconnection (?:closed|dropped|failed|lost|refused|reset|terminated)\b|\bnetwork (?:connection )?(?:error|failure)\b|\bfetch failed\b)/i;

export const classifyProviderTransportFailure = (name, detail) => {
  const normalizedName = normalizeTransportFailureText(name);
  const normalizedDetail = normalizeTransportFailureText(detail);
  const combined = [normalizedName, normalizedDetail].filter(Boolean).join(': ');
  const compactName = normalizedName.replace(/[^a-z0-9]+/gi, '');
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
  return message.includes('out of usage')
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

export const isDefiniteProviderUsageLimit = (value) => {
  return classifyProviderRetryFailure(value) === PROVIDER_USAGE_LIMIT_FAILURE_KIND;
};
