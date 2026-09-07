export function createCompressionPolicy({ shouldSkipApiCompression }) {
  function headerIncludesEventStream(value) {
    if (typeof value === 'string') {
      return value.toLowerCase().includes('text/event-stream');
    }

    if (Array.isArray(value)) {
      return value.some((entry) => typeof entry === 'string' && entry.toLowerCase().includes('text/event-stream'));
    }

    return false;
  }

  /**
   * SSE endpoint paths that must never be compressed by the compression middleware.
   *
   * The compression middleware filter runs before route handlers, so
   * `res.getHeader('Content-Type')` is still undefined at that point.
   * This means the Accept-header check alone is not sufficient for
   * non-standard clients (e.g. curl, fetch) that omit Accept.
   * Path-based exclusion acts as a deterministic fallback.
   */
  const SSE_PATH_PREFIXES = [
    '/api/event',
    '/api/global/event',
    '/api/notifications/stream',
    '/api/openchamber/events',
  ];

  function shouldSkipCompression(req, res) {
    if (headerIncludesEventStream(req.headers.accept)) {
      return true;
    }

    const pathname = req.path || req.url || '';
    if (
      pathname.startsWith('/api/browser/agent-leases/')
      && pathname.endsWith('/stream')
    ) {
      return true;
    }
    if ((pathname === '/api' || pathname.startsWith('/api/')) && shouldSkipApiCompression()) {
      return true;
    }

    if (pathname.startsWith('/api/terminal/') && pathname.endsWith('/stream')) {
      return true;
    }
    for (const prefix of SSE_PATH_PREFIXES) {
      if (pathname === prefix) {
        return true;
      }
    }

    return headerIncludesEventStream(res.getHeader('Content-Type'));
  }

  return { shouldSkipCompression };
}
