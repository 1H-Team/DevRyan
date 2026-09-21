export const LEGACY_UI_SESSION_COOKIE = 'oc_ui_session';

export function uiSessionCookieName(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('The UI session requires the actual listening port');
  return `${LEGACY_UI_SESSION_COOKIE}_${port}`;
}

// localPort comes from the accepted socket, never HTTP Host/forwarded headers.
export function requestUiSessionCookieName(req) {
  const port = req?.socket?.localPort;
  return Number.isInteger(port) && port > 0 && port <= 65535 ? uiSessionCookieName(port) : null;
}
