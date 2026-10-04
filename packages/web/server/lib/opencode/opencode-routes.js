// Shared browser-facing denial shape. Native route authorization lives in
// v2/route-policy.js; no legacy live-document or pass-through route registry.
export const OPENCODE_ROUTE_UNKNOWN_CODE = 'opencode_route_unknown';
export const OPENCODE_ROUTE_UNKNOWN_MESSAGE = 'Unknown OpenCode route';

export const createUnknownOpenCodeRoutePayload = () => ({
  error: OPENCODE_ROUTE_UNKNOWN_MESSAGE,
  code: OPENCODE_ROUTE_UNKNOWN_CODE,
});
