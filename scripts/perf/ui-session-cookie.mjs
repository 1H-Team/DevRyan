/** Use the cookie's actual name from this instance, including behind a proxy. */
export function uiSessionCookieHeader(cookie) {
  const match = typeof cookie === 'string' && /^oc_ui_session_(\d{1,5})=([^\s;]+)$/.exec(cookie);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535 || cookie.length > 8192) {
    throw new Error('Provide the instance UI cookie as oc_ui_session_<listening-port>=<value>. Its port may differ from the public URL.');
  }
  return cookie;
}
