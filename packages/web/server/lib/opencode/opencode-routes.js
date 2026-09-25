// Method-aware table of the routes the connected OpenCode server actually
// serves. OpenCode answers every unmatched path with its catch-all UI route,
// which proxies to app.opencode.ai (or serves the embedded index.html with a
// 200), so a request DevRyan sends to an unknown path never fails loudly. The
// guard built on this table rejects such requests locally instead.
//
// Source of truth, in order:
//   1. live: the running server's OpenAPI document (`GET /doc`), loaded in the
//      background once OpenCode is ready and again after a restart;
//   2. static: the table generated from the installed SDK v2 client
//      (`opencode-routes.generated.js`) plus DevRyan companion-only routes.
// Requests never wait for `/doc`; until it loads the static table applies.
import { OPENCODE_SDK_ROUTES } from './opencode-routes.generated.js';

export const OPENCODE_ROUTE_GUARD_ENV = 'DEVRYAN_OPENCODE_ROUTE_GUARD';
export const OPENCODE_ROUTE_UNKNOWN_CODE = 'opencode_route_unknown';
export const OPENCODE_ROUTE_UNKNOWN_MESSAGE = 'Unknown OpenCode route';
// OpenCode builds the spec lazily on the first `/doc` hit (~2 s measured locally).
export const OPENCODE_DOC_TIMEOUT_MS = 10_000;
export const OPENCODE_DOC_RETRY_DELAY_MS = 30_000;

// Added by the companion build (companion/legacy-conversation-revert.patch) and
// therefore absent from the published SDK. The live `/doc` lists them.
export const OPENCODE_COMPANION_ROUTES = Object.freeze([
  ['GET', '/session/revert-capabilities'],
  ['POST', '/session/retention-control'],
  ['POST', '/session/{sessionID}/external-message'],
]);

// Always known, whatever the source: `/doc` is a raw router route outside the
// spec it serves, and the event streams (SSE) and the PTY WebSocket upgrade are
// long-lived transports DevRyan must never cut off on a table mismatch.
export const OPENCODE_ALWAYS_KNOWN_ROUTES = Object.freeze([
  ['GET', '/doc'],
  ['GET', '/event'],
  ['GET', '/global/event'],
  ['GET', '/pty/{ptyID}/connect'],
]);

// A live spec that lacks OpenCode's health route is not OpenCode's spec.
const OPENCODE_DOC_REQUIRED_ROUTE = ['GET', '/global/health'];

const ROUTE_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
// WHATWG URL parsing resolves `.`/`..` including their percent-encoded forms.
const DOT_SEGMENT_PATTERN = /^(?:\.|%2e){1,2}$/i;
const URL_ORIGIN_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i;
const TEMPLATE_PARAM_PATTERN = /\{[^{}/]+\}/g;
const REPORTED_ROUTE_LIMIT = 256;
const REPORTED_PATH_MAX_CHARS = 160;

export const isOpenCodeRouteGuardEnabled = (env = process.env) => env[OPENCODE_ROUTE_GUARD_ENV] !== '0';

const hasControlCharacters = (value) => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

/**
 * Normalizes a request target (path, path+query, or absolute URL string) the
 * way OpenCode's router does before matching: query/fragment stripped,
 * duplicate slashes collapsed, trailing slash dropped. Returns null for targets
 * that are not a plain absolute path or that contain dot segments, backslashes
 * or control characters (traversal or ambiguous parsing).
 */
export const normalizeOpenCodePathname = (target) => {
  if (typeof target !== 'string' || target.length === 0) return null;
  let value = target;
  const origin = URL_ORIGIN_PATTERN.exec(value);
  if (origin) value = value.slice(origin[0].length) || '/';
  const end = value.search(/[?#]/);
  if (end !== -1) value = value.slice(0, end);
  if (!value.startsWith('/') || value.includes('\\') || hasControlCharacters(value)) return null;
  value = value.replace(/\/{2,}/g, '/');
  if (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
  if (value.split('/').some((segment) => DOT_SEGMENT_PATTERN.test(segment))) return null;
  return value;
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `{name}` matches one non-empty segment. A final `*` matches the remainder,
// including nothing (OpenCode registers `/x/*` for `/x` as well). Static text is
// case-insensitive like OpenCode's router.
const compileRoutePattern = (routePath) => {
  const normalized = routePath.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
  const segments = normalized.split('/').slice(1);
  let source = '';
  segments.forEach((segment, index) => {
    if (segment === '*' && index === segments.length - 1) {
      source += '(?:/.*)?';
      return;
    }
    let segmentSource = '';
    let cursor = 0;
    for (const match of segment.matchAll(TEMPLATE_PARAM_PATTERN)) {
      segmentSource += `${escapeRegExp(segment.slice(cursor, match.index))}[^/]+`;
      cursor = match.index + match[0].length;
    }
    source += `/${segmentSource}${escapeRegExp(segment.slice(cursor))}`;
  });
  return new RegExp(`^${source || '/'}$`, 'i');
};

const toRouteEntry = (entry) => {
  const [method, routePath] = Array.isArray(entry) ? entry : [entry?.method, entry?.path];
  if (typeof method !== 'string' || typeof routePath !== 'string' || !routePath.startsWith('/')) return null;
  const upper = method.toUpperCase();
  return ROUTE_METHODS.has(upper) ? [upper, routePath] : null;
};

/** Builds an immutable matcher over `[METHOD, path]` (or `{ method, path }`) entries. */
export const createOpenCodeRouteTable = (entries) => {
  const patternsByMethod = new Map();
  const seen = new Set();
  for (const entry of entries) {
    const route = toRouteEntry(entry);
    if (!route) continue;
    const key = `${route[0]} ${route[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const patterns = patternsByMethod.get(route[0]) ?? [];
    patterns.push(compileRoutePattern(route[1]));
    patternsByMethod.set(route[0], patterns);
  }

  const matchesMethod = (method, pathname) => (patternsByMethod.get(method) ?? []).some((pattern) => pattern.test(pathname));

  return Object.freeze({
    size: seen.size,
    /**
     * HEAD is not mapped to GET: OpenCode's catch-all is registered for every
     * method, so a HEAD request reaches the UI fallback before any GET route.
     * OPTIONS is accepted for any known path so CORS preflights still work.
     */
    has(method, target) {
      const pathname = normalizeOpenCodePathname(target);
      if (!pathname) return false;
      const upper = typeof method === 'string' && method.length > 0 ? method.toUpperCase() : 'GET';
      if (upper === 'OPTIONS') {
        return [...patternsByMethod.keys()].some((candidate) => matchesMethod(candidate, pathname));
      }
      return matchesMethod(upper, pathname);
    },
  });
};

const HTTP_OPENAPI_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

/** Extracts `[METHOD, path]` routes from an OpenAPI document; null when it has none. */
export const parseOpenApiRoutes = (doc) => {
  const paths = doc && typeof doc === 'object' && !Array.isArray(doc) ? doc.paths : null;
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) return null;
  const routes = [];
  for (const [routePath, item] of Object.entries(paths)) {
    if (!routePath.startsWith('/') || !item || typeof item !== 'object') continue;
    for (const method of HTTP_OPENAPI_METHODS) {
      if (item[method] && typeof item[method] === 'object') routes.push([method.toUpperCase(), routePath]);
    }
  }
  return routes.length > 0 ? routes : null;
};

export const OPENCODE_STATIC_ROUTES = Object.freeze([...OPENCODE_SDK_ROUTES, ...OPENCODE_COMPANION_ROUTES]);

export const createUnknownOpenCodeRoutePayload = () => ({
  error: OPENCODE_ROUTE_UNKNOWN_MESSAGE,
  code: OPENCODE_ROUTE_UNKNOWN_CODE,
});

export class OpenCodeRouteUnknownError extends Error {
  constructor(method) {
    super(`${OPENCODE_ROUTE_UNKNOWN_MESSAGE} (${method})`);
    this.name = 'OpenCodeRouteUnknownError';
    this.code = OPENCODE_ROUTE_UNKNOWN_CODE;
    this.statusCode = 404;
  }
}

export const isOpenCodeRouteUnknownError = (error) => error?.code === OPENCODE_ROUTE_UNKNOWN_CODE;

// Diagnostics carry only the method and the normalized path (never the query
// string, which holds directories and tokens), truncated and deduplicated.
const describeRejectedPath = (target) => {
  const pathname = normalizeOpenCodePathname(target);
  const value = pathname ?? '[unparseable]';
  return value.length > REPORTED_PATH_MAX_CHARS ? `${value.slice(0, REPORTED_PATH_MAX_CHARS)}…` : value;
};

export const createOpenCodeRouteRegistry = (options = {}) => {
  const {
    staticRoutes = OPENCODE_STATIC_ROUTES,
    docTimeoutMs = OPENCODE_DOC_TIMEOUT_MS,
    retryDelayMs = OPENCODE_DOC_RETRY_DELAY_MS,
    now = Date.now,
    logger = console,
  } = options;

  const staticTable = createOpenCodeRouteTable([...staticRoutes, ...OPENCODE_ALWAYS_KNOWN_ROUTES]);
  const reported = new Set();
  let docSource = {
    fetchImpl: options.fetchImpl ?? ((...args) => globalThis.fetch(...args)),
    buildDocUrl: options.buildDocUrl ?? null,
    getAuthHeaders: options.getAuthHeaders ?? (() => ({})),
    recordDiagnostic: options.recordDiagnostic ?? null,
  };
  let liveTable = null;
  let liveKey = null;
  let observedKey = null;
  let staleSinceNotReady = false;
  let inflight = null;
  let failedKey = null;
  let failedAt = 0;

  const getTable = () => liveTable ?? staticTable;

  const configure = (next = {}) => {
    docSource = {
      ...docSource,
      ...Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)),
    };
  };

  const loadLiveTable = async () => {
    if (typeof docSource.buildDocUrl !== 'function') {
      throw new Error('OpenCode /doc source is not configured');
    }
    const response = await docSource.fetchImpl(docSource.buildDocUrl(), {
      method: 'GET',
      headers: { Accept: 'application/json', ...docSource.getAuthHeaders() },
      signal: AbortSignal.timeout(docTimeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`OpenCode /doc returned ${response.status}`);
    }
    const routes = parseOpenApiRoutes(await response.json());
    if (!routes) throw new Error('OpenCode /doc has no paths');
    const table = createOpenCodeRouteTable([...routes, ...OPENCODE_ALWAYS_KNOWN_ROUTES]);
    if (!table.has(...OPENCODE_DOC_REQUIRED_ROUTE)) {
      throw new Error('OpenCode /doc does not describe an OpenCode server');
    }
    return table;
  };

  /** Loads the live table for the runtime identified by `key`; resolves true on success. */
  const refresh = (key = observedKey) => {
    if (inflight) return inflight;
    const attempt = (async () => {
      try {
        const table = await loadLiveTable();
        if (key !== observedKey) return false; // the runtime changed while loading
        liveTable = table;
        liveKey = key;
        failedKey = null;
        return true;
      } catch (error) {
        // Retries stay quiet: one warning per runtime identity.
        if (failedKey !== key) {
          logger?.warn?.(`[opencode-routes] live route table unavailable; using the static table: ${error?.message ?? error}`);
        }
        failedKey = key;
        failedAt = now();
        return false;
      }
    })();
    inflight = attempt.finally(() => {
      inflight = null;
    });
    return inflight;
  };

  /**
   * Called on the request path with the current runtime identity (target plus
   * version). Never blocks: it only schedules a background `/doc` load when the
   * runtime is ready and the live table is missing, from another runtime, or
   * predates an observed not-ready period (a restart).
   */
  const observeRuntime = ({ ready, key }) => {
    if (!ready) {
      if (liveKey !== null) staleSinceNotReady = true;
      return;
    }
    if (key !== observedKey) {
      observedKey = key;
      if (liveKey !== key) {
        liveTable = null;
        liveKey = null;
      }
    }
    if (liveKey === key && !staleSinceNotReady) return;
    if (inflight) return;
    if (failedKey === key && now() - failedAt < retryDelayMs) return;
    staleSinceNotReady = false;
    void refresh(key);
  };

  const reportUnknown = (method, target, source) => {
    const upper = typeof method === 'string' && method.length > 0 ? method.toUpperCase() : 'GET';
    const pathname = describeRejectedPath(target);
    const key = `${upper} ${pathname}`;
    if (reported.has(key)) return;
    if (reported.size >= REPORTED_ROUTE_LIMIT) reported.delete(reported.values().next().value);
    reported.add(key);
    const table = liveTable ? 'live' : 'static';
    logger?.warn?.(`[opencode-routes] rejected unknown OpenCode route ${key} (source=${source}, table=${table})`);
    try {
      void Promise.resolve(docSource.recordDiagnostic?.({
        type: 'log',
        event: 'opencode_route_unknown',
        payload: { method: upper, path: pathname, source, table },
      })).catch(() => {});
    } catch {
      // Diagnostics never change the rejection.
    }
  };

  return {
    configure,
    observeRuntime,
    refresh,
    reportUnknown,
    isKnown: (method, target) => getTable().has(method, target),
    getSource: () => (liveTable ? 'live' : 'static'),
  };
};

/** Process-wide registry shared by the proxy and server-side OpenCode helpers. */
export const openCodeRouteRegistry = createOpenCodeRouteRegistry();

export const isKnownOpenCodeRoute = (method, target) => openCodeRouteRegistry.isKnown(method, target);

/** Throws `OpenCodeRouteUnknownError` (after one bounded diagnostic) for an unknown route. */
export const assertKnownOpenCodeRoute = (method, target, { registry = openCodeRouteRegistry, source = 'server' } = {}) => {
  if (!isOpenCodeRouteGuardEnabled()) return;
  if (registry.isKnown(method, target)) return;
  registry.reportUnknown(method, target, source);
  throw new OpenCodeRouteUnknownError(typeof method === 'string' && method ? method.toUpperCase() : 'GET');
};

const describeFetchTarget = (target) => {
  if (target instanceof URL) return `${target.pathname}${target.search}`;
  if (typeof Request !== 'undefined' && target instanceof Request) return target.url;
  return String(target);
};

/**
 * `fetch` for requests addressed to OpenCode: rejects with
 * `OpenCodeRouteUnknownError` before any network I/O when the route is unknown.
 */
export const openCodeFetch = async (target, init = {}, options = {}) => {
  const { fetchImpl = globalThis.fetch, registry, source } = options;
  const method = init?.method
    ?? (typeof Request !== 'undefined' && target instanceof Request ? target.method : 'GET');
  assertKnownOpenCodeRoute(method, describeFetchTarget(target), { registry, source });
  return fetchImpl(target, init);
};

/**
 * Express middleware for the generic OpenCode pass-through: answers unknown
 * routes with a local 404 so they are never forwarded.
 */
export const createOpenCodeRouteGuardMiddleware = ({ registry = openCodeRouteRegistry, resolveUpstreamPath }) => (req, res, next) => {
  if (!isOpenCodeRouteGuardEnabled()) return next();
  const upstreamPath = resolveUpstreamPath(req);
  if (registry.isKnown(req.method, upstreamPath)) return next();
  registry.reportUnknown(req.method, upstreamPath, 'proxy');
  return res.status(404).json(createUnknownOpenCodeRoutePayload());
};
