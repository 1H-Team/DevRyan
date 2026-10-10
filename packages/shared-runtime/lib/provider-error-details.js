// Provider bodies can contain prompts and credentials. Only these finite values
// may cross the error projection and diagnostic journal boundaries.
const CODES = new Set([
  'subscription_sharing_user_not_eligible', 'subscription_sharing_usage_limit_exceeded',
  'subscription_sharing_usage_unavailable', 'subscription_sharing_unsupported_capability',
  'subscription_sharing_route_not_supported', 'subscription_sharing_invalid_user',
  'subscription_sharing_user_unavailable', 'chatpass_v2_scope_not_authorized',
  'chatpass_v2_invalid_authorization_context', 'invalid_api_key', 'invalid_authentication',
  'authentication_error', 'insufficient_quota', 'quota_exceeded', 'usage_limit_exceeded',
  'rate_limit_exceeded', 'too_many_requests', 'unsupported_parameter', 'unsupported_value',
  'unsupported_capability', 'model_not_found', 'invalid_request_error',
]);
const PARAMS = new Set([
  'tools', 'tools.type', 'tool_choice', 'parallel_tool_calls', 'reasoning.effort',
  'reasoning.summary', 'temperature', 'top_p', 'max_output_tokens', 'stream', 'model',
  'input', 'store', 'text.verbosity', 'include', 'service_tier',
]);
const TYPES = new Set([
  'provider.auth', 'provider.error', 'provider.rate-limit', 'provider.quota',
  'provider.transport', 'provider.internal', 'provider.invalid-output',
  'provider.invalid-request', 'provider.unsupported-operation', 'provider.no-route',
  'provider.unknown', 'provider.timeout', 'provider.content-filter', 'aborted',
  'permission.rejected', 'tool.execution', 'unknown',
]);
export const isSafeProviderCode = value => typeof value === 'string' && CODES.has(value);
export const isSafeProviderParam = value => typeof value === 'string' && PARAMS.has(value);
export const isSafeErrorType = value => typeof value === 'string' && TYPES.has(value);
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export const providerErrorDetails = body => {
  if (typeof body !== 'string' || body.length > 65536) return {};
  let event;
  try { event = JSON.parse(body); } catch { return {}; }
  if (!isRecord(event)) return {};
  const nested = isRecord(event.error) ? event.error
    : isRecord(event.response) && isRecord(event.response.error) ? event.response.error : {};
  const code = event.code ?? nested.code, param = event.param ?? nested.param;
  return {
    ...(isSafeProviderCode(code) ? { providerCode: code } : {}),
    ...(isSafeProviderParam(param) ? { providerParam: param } : {}),
  };
};
