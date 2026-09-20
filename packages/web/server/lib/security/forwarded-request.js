// Headers that a reverse proxy, CDN or tunnel attaches on the way to the origin.
//
// Their presence means the request did not arrive directly from its client, so
// neither the socket peer nor the Host header describes the caller: they
// describe the last hop. Cloudflare Tunnel makes this concrete — cloudflared
// dials the local service from the same machine, so every public request lands
// on a loopback socket.
//
// None of these values are trustworthy on their own. Cloudflare's edge manages
// X-Forwarded-For and overwrites X-Forwarded-Proto, but it passes a
// client-supplied X-Forwarded-Host through untouched, which is precisely the
// precondition Express requires before `trust proxy` may be believed. Treat any
// of them as proof only of indirection, never of identity.
export const FORWARDING_HEADERS = Object.freeze([
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'cf-connecting-ip',
]);

// Fails closed: a request carrying any forwarding header is never direct, so
// callers must not grant it the trust they extend to a genuinely local client.
export const hasForwardingHeaders = (req) => Object.keys(req?.headers || {}).some((name) => {
  const header = name.toLowerCase();
  return header === 'forwarded' || header.startsWith('x-forwarded-') || header.startsWith('cf-');
});
