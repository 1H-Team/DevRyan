// DevRyan's own REST routes live under /api/devryan. A stale or cached tab, a
// tunnel client, an older runtime service caller or a retained native controller
// may still call the accepted /api/openchamber alias. The rewrite runs as the
// first middleware of every composition, before admission, authentication,
// multi-user and tunnel policy, and updates both `req.url` and
// `req.originalUrl`, so every check only ever sees the canonical path.
export const API_PREFIX = '/api/devryan';
export const LEGACY_API_PREFIX = '/api/openchamber';

/** The canonical form of a request URL; any other URL is returned unchanged. */
export function canonicalApiUrl(url) {
  if (typeof url !== 'string' || !url.startsWith(LEGACY_API_PREFIX)) return url;
  const rest = url.slice(LEGACY_API_PREFIX.length);
  return rest === '' || rest[0] === '/' || rest[0] === '?' ? `${API_PREFIX}${rest}` : url;
}

export function legacyApiPathRewrite(req, _res, next) {
  const canonical = canonicalApiUrl(req.url);
  if (canonical !== req.url) {
    req.url = canonical;
    req.originalUrl = canonicalApiUrl(req.originalUrl ?? canonical);
  }
  next();
}
