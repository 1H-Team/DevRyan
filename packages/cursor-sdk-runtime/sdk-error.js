const names = new Set(['CursorSdkError', 'CursorAgentError', 'AuthenticationError', 'RateLimitError', 'ConfigurationError',
  'AgentBusyError', 'IntegrationNotConnectedError', 'NetworkError', 'UnknownAgentError', 'AgentNotFoundError']);
const associationReasons = new Set(['missing', 'unavailable', 'limit', 'shape', 'mismatch']);
export const cursorProviderFailure = error => names.has(error?.name) || error?.cursorFailureSource === 'provider';
export function cursorErrorDetails(error) {
  return { ...(names.has(error?.name) ? { name: error.name } : {}),
    ...(typeof error?.code === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(error.code) ? { code: error.code } : {}),
    ...(error?.code === 'CURSOR_STREAM_FINAL_ASSOCIATION_INVALID' && associationReasons.has(error?.reason) ? { reason: error.reason } : {}),
    ...(cursorProviderFailure(error) ? { source: 'provider' } : {}) };
}
export function cursorWorkerFailure(message, details = {}) {
  return Object.assign(new Error(message), cursorErrorDetails(details),
    details.source === 'provider' ? { cursorFailureSource: 'provider' } : {});
}
