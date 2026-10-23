// Headers that a reverse proxy, CDN or tunnel attaches on the way to the origin.

// Fails closed: a request carrying any forwarding header is never direct, so
// callers must not grant it the trust they extend to a genuinely local client.
export const hasForwardingHeaders = (req) => Object.keys(req?.headers || {}).some((name) => {
  const header = name.toLowerCase();
  return header === 'forwarded' || header.startsWith('x-forwarded-') || header.startsWith('cf-');
});
