import { hasForwardingHeaders } from './forwarded-request.js';

// A connector also uses a loopback socket. Local authority requires all three
// observations to agree, without Express's trust-proxy hostname/IP getters.
export function isDirectLocalRequest(req) {
  const address = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  const host = req.headers?.host;
  if (!['127.0.0.1', '::1'].includes(address) || typeof host !== 'string' || hasForwardingHeaders(req)) return false;
  if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::[1-9][0-9]{0,4})?$/i.test(host)) return false;
  try {
    const authority = new URL(`http://${host}`);
    if (req.headers.origin !== undefined) {
      const origin = new URL(req.headers.origin);
      if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== authority.host) return false;
    }
    return true;
  } catch { return false; }
}
