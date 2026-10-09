// Deny-by-default route policy for the OpenCode 2.x HTTP surface (gen 2).
//
// Every `(method, template)` in the vendored OpenAPI document
// (`routes.generated.js`), plus `GET /openapi.json`, has exactly one class:
//   browser     forwardable for the browser (`/api/opencode-v2/*`) and any server caller;
//   server      DevRyan server modules through `openCodeClient`;
//   privileged  only the privileged client (admission, scoped revert, config apply,
//               execution host);
//   deny        never sent upstream.
// Anything that does not match a known route exactly, after normalization, is
// denied. Body-dependent operations (PATCH/POST session, synthetic) can raise
// the effective class or deny outright; see `classifyOpenCodeV2Body`.
//
// Callers forward `canonicalPath` (the normalized, re-encoded path), never the
// raw request target, so the upstream router sees what the policy judged.
import path from 'node:path';

import { extractOpenCodeV2Operations, openCodeV2RouteKey } from './openapi-routes.js';
import { OPENCODE_V2_OPENAPI_SHA256, OPENCODE_V2_ROUTES, OPENCODE_V2_ROUTES_VERSION } from './routes.generated.js';

export const OPENCODE_V2_ROUTE_CLASS = Object.freeze({
  BROWSER: 'browser',
  SERVER: 'server',
  PRIVILEGED: 'privileged',
  DENY: 'deny',
});

/** Who is sending: the browser (raw pass-through), a server module, or the privileged client. */
export const OPENCODE_V2_AUDIENCE = Object.freeze({
  BROWSER: 'browser',
  SERVER: 'server',
  PRIVILEGED: 'privileged',
});

const B = OPENCODE_V2_ROUTE_CLASS.BROWSER;
const S = OPENCODE_V2_ROUTE_CLASS.SERVER;
const P = OPENCODE_V2_ROUTE_CLASS.PRIVILEGED;
const D = OPENCODE_V2_ROUTE_CLASS.DENY;

/**
 * Routes served by the host outside its OpenAPI paths. `/openapi.json` is read
 * by the readiness drift check (`diffLiveSpec`).
 */
export const OPENCODE_V2_EXTRA_ROUTES = Object.freeze([
  Object.freeze({
    method: 'GET',
    template: '/openapi.json',
    operationId: 'devryan.openapi.document',
    location: 'none',
    pathParams: Object.freeze([]),
    query: Object.freeze([]),
    body: null,
    stream: null,
  }),
]);

/**
 * The explicit class of every known route (DESIGN.md C.3). A route the
 * generated table lists without an entry here is denied, and the test suite
 * fails until it is classified.
 */
export const OPENCODE_V2_ROUTE_CLASSES = Object.freeze({
  // Server and pairing. Only the info probe is browser-visible.
  'GET /api/info': B,
  'GET /openapi.json': S,
  'POST /api/pair': D,
  'GET /auth/connect/{code}': D,

  // Location, plugins and debug.
  'GET /api/location': S,
  'POST /api/location/reload': P,
  'GET /api/plugin': S,
  'POST /api/plugin/check': D,
  'POST /api/plugin/update': D,
  'POST /api/rpc/{rpcID}/{method}': D,
  'GET /api/debug/location': D,
  'DELETE /api/debug/location': D,
  'GET /api/experimental/migration/v1': S,

  // Catalog reads.
  'GET /api/agent': S,
  'GET /api/agent/{agentID}': S,
  'GET /api/command': S,
  'GET /api/skill': S,
  'GET /api/model': S,
  'GET /api/model/default': S,
  'GET /api/provider': S,
  'GET /api/provider/{providerID}': S,
  'GET /api/reference': S,
  'GET /api/project': S,
  'PATCH /api/project/{projectID}': D,
  'GET /api/config': S,
  'GET /api/config/shell': D,
  'PATCH /api/experimental/config': D,
  'GET /api/vcs': S,
  'GET /api/vcs/base': S,
  'GET /api/vcs/branch': S,
  'GET /api/vcs/diff': S,
  'GET /api/vcs/status': S,
  'POST /api/vcs/init': D,
  'GET /api/websearch/provider': S,
  'POST /api/websearch': D,
  'POST /api/experimental/generate': D,

  // Events.
  'GET /api/event': S,

  // Sessions.
  'GET /api/session': S,
  'POST /api/session': S, // body rule: permissions/metadata need the privileged client
  'GET /api/session/active': S,
  'GET /api/session/{sessionID}': S,
  'PATCH /api/session/{sessionID}': S, // body rule: title only; permissions/metadata are privileged
  'DELETE /api/session/{sessionID}': S,
  'POST /api/session/{sessionID}/fork': S,
  'POST /api/session/{sessionID}/agent': P,
  'POST /api/session/{sessionID}/model': P,
  'POST /api/session/{sessionID}/move': D,
  'PUT /api/session/{sessionID}/environment': D,
  'POST /api/session/{sessionID}/prompt': S,
  'POST /api/session/{sessionID}/command': S,
  'POST /api/session/{sessionID}/compact': S,
  'POST /api/session/{sessionID}/interrupt': S,
  'POST /api/session/{sessionID}/background': P,
  'POST /api/session/{sessionID}/synthetic': P, // body rule: never metadata.source "subagent"
  'POST /api/session/{sessionID}/shell': D,
  'POST /api/session/{sessionID}/generate': D,
  'POST /api/session/{sessionID}/view': S,
  'GET /api/session/{sessionID}/context': S,
  'GET /api/session/{sessionID}/diff': S,
  'GET /api/session/{sessionID}/message': S,
  'GET /api/session/{sessionID}/message/{messageID}': S,
  'POST /api/session/{sessionID}/revert/stage': P,
  'POST /api/session/{sessionID}/revert/commit': P,
  'DELETE /api/session/{sessionID}/revert': P,
  'GET /api/session/{sessionID}/inbox': S,
  'PATCH /api/session/{sessionID}/inbox/{inboxID}': D,
  'DELETE /api/session/{sessionID}/inbox/{inboxID}': D,
  'GET /api/session/{sessionID}/form': S,
  'POST /api/session/{sessionID}/form': D,
  'GET /api/session/{sessionID}/form/{formID}': S,
  'DELETE /api/session/{sessionID}/form/{formID}': S,
  'POST /api/session/{sessionID}/form/{formID}/reply': S,
  'GET /api/session/{sessionID}/permission': S,
  'POST /api/session/{sessionID}/permission': D,
  'GET /api/session/{sessionID}/permission/{requestID}': S,
  'POST /api/session/{sessionID}/permission/{requestID}/reply': S,
  'GET /api/experimental/session/stats': S,
  'POST /api/experimental/session/import': D,
  'GET /api/experimental/session/{sessionID}/export': D,
  'GET /api/experimental/session/{sessionID}/log': S,
  'POST /api/experimental/session/{sessionID}/skill': D,
  'POST /api/experimental/session/{sessionID}/wait': S,
  'GET /api/experimental/session/{sessionID}/instructions/entries': S,
  'PUT /api/experimental/session/{sessionID}/instructions/entries/{key}': P,
  'DELETE /api/experimental/session/{sessionID}/instructions/entries/{key}': P,

  // Interaction lists.
  'GET /api/form': S,
  'GET /api/permission/request': S,
  'GET /api/permission/saved': S,
  // Not in the C.3 server enumeration and no DevRyan consumer: denied until one exists.
  'DELETE /api/permission/saved/{id}': D,

  // Integrations and credentials. GET /api/credential returns secret values (G4).
  'GET /api/integration': S,
  'GET /api/integration/{integrationID}': S,
  'POST /api/integration/{integrationID}/connect/key': S,
  'POST /api/integration/{integrationID}/connect/oauth': S,
  'GET /api/integration/{integrationID}/connect/oauth/{attemptID}': S,
  'DELETE /api/integration/{integrationID}/connect/oauth/{attemptID}': S,
  'POST /api/integration/{integrationID}/connect/oauth/{attemptID}/complete': S,
  'POST /api/integration/{integrationID}/connect/command': D,
  'GET /api/integration/{integrationID}/connect/command/{attemptID}': D,
  'DELETE /api/integration/{integrationID}/connect/command/{attemptID}': D,
  // 2.0.26 external sources (e.g. Azure CLI) run outside DevRyan's credential owners: denied.
  'POST /api/integration/{integrationID}/connect/external': D,
  'POST /api/experimental/integration/wellknown': D,
  'GET /api/credential': P,
  'POST /api/credential': S,
  'PATCH /api/credential/{credentialID}': S,
  'DELETE /api/credential/{credentialID}': S,
  'POST /api/credential/{credentialID}/activate': S,

  // MCP.
  'GET /api/mcp': S,
  'GET /api/mcp/resource': S,
  'PUT /api/experimental/mcp/{server}': D,
  'DELETE /api/experimental/mcp/{server}': D,
  'POST /api/experimental/mcp/{server}/connect': S,
  'POST /api/experimental/mcp/{server}/disconnect': S,

  // Files: DevRyan serves its own file routes.
  'GET /api/fs/read/*': D,
  'GET /api/fs/list': D,
  'GET /api/fs/find': D,
  'POST /api/experimental/fs/write': D,

  // Terminals and shells.
  'GET /api/pty': D,
  'POST /api/pty': D,
  'GET /api/pty/{ptyID}': D,
  'PUT /api/pty/{ptyID}': D,
  'DELETE /api/pty/{ptyID}': D,
  'POST /api/pty/{ptyID}/connect-token': D,
  'GET /api/pty/{ptyID}/connect': D,
  'POST /api/experimental/persistent-pty/shutdown': D,
  'POST /api/experimental/persistent-pty/handoff': D,
  'GET /api/experimental/persistent-pty/{ptyID}': D,
  'PUT /api/experimental/persistent-pty/{ptyID}': D,
  'DELETE /api/experimental/persistent-pty/{ptyID}': D,
  'GET /api/experimental/persistent-pty/{ptyID}/snapshot': D,
  'POST /api/experimental/persistent-pty/{ptyID}/connect-token': D,
  'GET /api/experimental/persistent-pty/{ptyID}/connect': D,
  'GET /api/experimental/session/{sessionID}/terminal': D,
  'POST /api/experimental/session/{sessionID}/terminal': D,
  'GET /api/experimental/session/{sessionID}/terminal/read': D,
  'GET /api/shell': D,
  'POST /api/shell': D,
  'GET /api/shell/{id}': D,
  'DELETE /api/shell/{id}': D,
  'GET /api/shell/{id}/output': D,

  // Worktrees.
  'GET /api/worktree': D,
  'POST /api/worktree': D,
  'DELETE /api/worktree': D,
  'POST /api/worktree/refresh': D,
});

const CLASS_RANK = Object.freeze({ [B]: 0, [S]: 1, [P]: 2 });
const AUDIENCE_RANK = Object.freeze({ browser: 0, server: 1, privileged: 2 });

const MAX_PATH_LENGTH = 4096;
const URL_ORIGIN_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const hasControlCharacter = (value) => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

/**
 * Normalizes a request target (path, path plus query, or absolute URL) for
 * matching: query and fragment split off, empty segments (`//`, trailing `/`)
 * and `.` segments dropped, every segment percent-decoded once. Rejects, with a
 * reason, anything whose meaning could differ between DevRyan and the upstream
 * router: `..` (raw or encoded), an encoded `/` or `\` inside a segment, raw
 * backslashes, control characters (raw or encoded) and malformed escapes.
 *
 * @returns {{ ok: true, segments: string[], canonicalPath: string, search: string } | { ok: false, reason: string }}
 */
export const normalizeOpenCodeV2Path = (target) => {
  if (typeof target !== 'string' || target.length === 0) return { ok: false, reason: 'path_invalid' };
  if (target.length > MAX_PATH_LENGTH) return { ok: false, reason: 'path_too_long' };
  let value = target;
  const origin = URL_ORIGIN_PATTERN.exec(value);
  if (origin) value = value.slice(origin[0].length) || '/';
  const hashIndex = value.indexOf('#');
  if (hashIndex !== -1) value = value.slice(0, hashIndex);
  const queryIndex = value.indexOf('?');
  const search = queryIndex === -1 ? '' : value.slice(queryIndex);
  if (queryIndex !== -1) value = value.slice(0, queryIndex);
  if (!value.startsWith('/')) return { ok: false, reason: 'path_invalid' };
  if (value.includes('\\')) return { ok: false, reason: 'backslash' };
  if (hasControlCharacter(value)) return { ok: false, reason: 'control_character' };

  const segments = [];
  for (const raw of value.split('/')) {
    if (raw === '') continue;
    let decoded;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return { ok: false, reason: 'malformed_encoding' };
    }
    if (decoded === '.') continue;
    if (decoded === '..') return { ok: false, reason: 'dot_dot_segment' };
    if (decoded.includes('/')) return { ok: false, reason: 'encoded_separator' };
    if (decoded.includes('\\')) return { ok: false, reason: 'backslash' };
    if (hasControlCharacter(decoded)) return { ok: false, reason: 'control_character' };
    segments.push(decoded);
  }
  const canonicalPath = `/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`;
  return { ok: true, segments, canonicalPath, search };
};

const compilePattern = (pattern) => {
  if (pattern === null) return null;
  try {
    return new RegExp(pattern, 'u');
  } catch {
    return false; // an uncompilable pattern can never match: fail closed
  }
};

const compileRoute = (route) => {
  const patterns = new Map(route.pathParams.map((parameter) => [parameter.name, compilePattern(parameter.pattern)]));
  const parts = route.template.split('/').slice(1).map((segment, index, all) => {
    if (segment === '*' && index === all.length - 1) return { kind: 'rest' };
    const param = /^\{([^{}/]+)\}$/.exec(segment);
    if (param) return { kind: 'param', name: param[1], pattern: patterns.get(param[1]) ?? null };
    return { kind: 'static', value: segment };
  });
  const paramCount = parts.filter((part) => part.kind !== 'static').length;
  return { route, parts, paramCount, hasRest: parts.some((part) => part.kind === 'rest') };
};

const matchCompiled = (compiled, segments) => {
  const params = {};
  const { parts } = compiled;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part.kind === 'rest') {
      const rest = segments.slice(index);
      if (rest.length === 0) return null;
      params['*'] = rest.join('/');
      return params;
    }
    const segment = segments[index];
    if (segment === undefined) return null;
    if (part.kind === 'static') {
      if (segment !== part.value) return null;
      continue;
    }
    if (part.pattern === false) return null;
    if (part.pattern && !part.pattern.test(segment)) return null;
    params[part.name] = segment;
  }
  return segments.length === parts.length ? params : null;
};

const buildMatcher = (routes) => {
  const byMethod = new Map();
  for (const route of routes) {
    const list = byMethod.get(route.method) ?? [];
    list.push(compileRoute(route));
    byMethod.set(route.method, list);
  }
  // Static segments win over parameters (`/api/session/active` before `{sessionID}`).
  for (const list of byMethod.values()) {
    list.sort((left, right) => (left.paramCount - right.paramCount)
      || (Number(left.hasRest) - Number(right.hasRest))
      || (left.route.template < right.route.template ? -1 : left.route.template > right.route.template ? 1 : 0));
  }
  return byMethod;
};

const KNOWN_ROUTES = Object.freeze([...OPENCODE_V2_ROUTES, ...OPENCODE_V2_EXTRA_ROUTES]);
const MATCHER = buildMatcher(KNOWN_ROUTES);

/** Every route the policy knows (the generated table plus `GET /openapi.json`). */
export const listOpenCodeV2KnownRoutes = () => KNOWN_ROUTES;

const normalizeMethod = (method) => (typeof method === 'string' && method.length > 0 ? method.toUpperCase() : null);

/**
 * Matches a request against the known routes. Matching is exact on decoded
 * segments (case-sensitive), honours the spec's path-parameter patterns and
 * never maps HEAD or OPTIONS onto other methods.
 *
 * @returns {{ ok: true, route: object, params: Record<string, string>, canonicalPath: string, search: string }
 *   | { ok: false, reason: string, canonicalPath: string | null }}
 */
export const matchOpenCodeV2Route = (method, target) => {
  const normalized = normalizeOpenCodeV2Path(target);
  if (!normalized.ok) return { ok: false, reason: normalized.reason, canonicalPath: null };
  const upper = normalizeMethod(method);
  const candidates = upper ? MATCHER.get(upper) : undefined;
  if (candidates) {
    for (const compiled of candidates) {
      const params = matchCompiled(compiled, normalized.segments);
      if (params) {
        return { ok: true, route: compiled.route, params, canonicalPath: normalized.canonicalPath, search: normalized.search };
      }
    }
  }
  return { ok: false, reason: 'route_unknown', canonicalPath: normalized.canonicalPath };
};

/** The static class of a known `(method, template)`; unknown or unclassified is `deny`. */
export const getOpenCodeV2RouteClass = (method, template) => {
  const upper = normalizeMethod(method);
  if (!upper || typeof template !== 'string') return D;
  return OPENCODE_V2_ROUTE_CLASSES[openCodeV2RouteKey(upper, template)] ?? D;
};

const SESSION_PRIVILEGED_BODY_KEYS = Object.freeze(['metadata', 'permissions']);

/** Keys the browser façade may forward in `PATCH /api/session/:id` (C.3 body rule). */
export const OPENCODE_V2_BROWSER_SESSION_PATCH_KEYS = Object.freeze(['title']);

const classifySessionWriteBody = (route, body) => {
  if (!isRecord(body)) return { routeClass: D, reason: 'body_invalid' };
  const allowed = route.body?.keys ?? [];
  // Native 2.0.26 adds parentID; child creation remains owned by managed delegation.
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key) || key === 'parentID');
  if (unknown.length > 0) return { routeClass: D, reason: 'body_key_not_allowed', keys: unknown.sort() };
  const privileged = Object.keys(body).filter((key) => SESSION_PRIVILEGED_BODY_KEYS.includes(key) && body[key] !== undefined);
  if (privileged.length > 0) return { routeClass: P, reason: 'body_requires_privileged', keys: privileged.sort() };
  return { routeClass: S, reason: null };
};

const classifySyntheticBody = (_route, body) => {
  if (!isRecord(body)) return { routeClass: D, reason: 'body_invalid' };
  // Subagent completions are identified in-process; a caller-supplied source is a spoof (G1 verifier item 2).
  if (isRecord(body.metadata) && body.metadata.source === 'subagent') {
    return { routeClass: D, reason: 'synthetic_subagent_source_reserved' };
  }
  return { routeClass: P, reason: null };
};

const BODY_RULES = Object.freeze({
  'POST /api/session': classifySessionWriteBody,
  'PATCH /api/session/{sessionID}': classifySessionWriteBody,
  'POST /api/session/{sessionID}/synthetic': classifySyntheticBody,
});

/** True when the effective class of `(method, template)` depends on the request body. */
export const hasOpenCodeV2BodyRule = (method, template) => Object.hasOwn(BODY_RULES, openCodeV2RouteKey(normalizeMethod(method) ?? '', template));

/**
 * The effective class of a body-dependent operation. Returns the static class
 * for operations without a body rule. A required body that is missing denies.
 */
export const classifyOpenCodeV2Body = (route, body) => {
  const key = openCodeV2RouteKey(route.method, route.template);
  const staticClass = OPENCODE_V2_ROUTE_CLASSES[key] ?? D;
  const rule = BODY_RULES[key];
  if (staticClass === D || !rule) return { routeClass: staticClass, reason: null };
  if (body === undefined || body === null) {
    return route.body?.required ? { routeClass: D, reason: 'body_required' } : { routeClass: staticClass, reason: null };
  }
  const result = rule(route, body);
  // A body rule can only raise the requirement, never lower it below the static class.
  if (result.routeClass !== D && CLASS_RANK[result.routeClass] < CLASS_RANK[staticClass]) {
    return { ...result, routeClass: staticClass };
  }
  return result;
};

/**
 * The browser façade's `PATCH /api/session/:id` guard: only `title` may pass.
 * @returns {{ ok: true } | { ok: false, reason: string, keys?: string[] }}
 */
export const checkBrowserSessionPatchBody = (body) => {
  if (!isRecord(body)) return { ok: false, reason: 'body_invalid' };
  const rejected = Object.keys(body).filter((key) => !OPENCODE_V2_BROWSER_SESSION_PATCH_KEYS.includes(key));
  if (rejected.length > 0) return { ok: false, reason: 'body_key_not_allowed', keys: rejected.sort() };
  if (body.title !== undefined && body.title !== null && typeof body.title !== 'string') {
    return { ok: false, reason: 'body_invalid' };
  }
  return { ok: true };
};

/**
 * Decides whether `audience` may send this request upstream.
 *
 * `body` is the parsed JSON body; it is required for body-dependent operations
 * (`hasOpenCodeV2BodyRule`), and leaving it out denies them when the spec
 * requires a body. Location binding is separate (`bindOpenCodeV2Location`).
 *
 * @param {{ audience: 'browser' | 'server' | 'privileged', method: string, path: string, body?: unknown }} request
 */
export const evaluateOpenCodeV2Request = ({ audience, method, path: target, body } = {}) => {
  const audienceRank = AUDIENCE_RANK[audience];
  const match = matchOpenCodeV2Route(method, target);
  if (!match.ok) {
    return {
      allowed: false,
      routeClass: D,
      reason: match.reason === 'route_unknown' ? 'route_unknown' : 'path_rejected',
      detail: match.reason === 'route_unknown' ? null : match.reason,
      route: null,
      params: {},
      canonicalPath: match.canonicalPath,
      search: '',
    };
  }
  const base = { route: match.route, params: match.params, canonicalPath: match.canonicalPath, search: match.search };
  if (audienceRank === undefined) {
    return { allowed: false, routeClass: D, reason: 'audience_invalid', detail: null, ...base };
  }
  const classified = classifyOpenCodeV2Body(match.route, body);
  if (classified.routeClass === D) {
    return {
      allowed: false,
      routeClass: D,
      reason: classified.reason ? 'body_rejected' : 'route_denied',
      detail: classified.reason ?? null,
      ...(classified.keys ? { keys: classified.keys } : {}),
      ...base,
    };
  }
  if (CLASS_RANK[classified.routeClass] > audienceRank) {
    return {
      allowed: false,
      routeClass: classified.routeClass,
      reason: 'audience_insufficient',
      detail: classified.reason ?? null,
      ...(classified.keys ? { keys: classified.keys } : {}),
      ...base,
    };
  }
  return { allowed: true, routeClass: classified.routeClass, reason: null, detail: null, ...base };
};

// ---------------------------------------------------------------------------
// Location binding (G1/G5 verifier): a request may only address a directory
// inside one of DevRyan's project roots, and a location-scoped operation must
// name one (v2 otherwise falls back to the host process cwd).

const LOCATION_QUERY_KEY = 'location[directory]';
const LOCATION_HEADER = 'x-opencode-directory';

const readQueryValues = (query, key) => {
  if (query === undefined || query === null) return [];
  if (typeof query === 'string') {
    return new URLSearchParams(query.startsWith('?') ? query.slice(1) : query).getAll(key);
  }
  if (query instanceof URLSearchParams) return query.getAll(key);
  if (!isRecord(query)) return [{ invalid: true }];
  const values = [];
  if (Object.hasOwn(query, key)) values.push(query[key]);
  // Express (qs) parses `location[directory]=x` into `{ location: { directory: x } }`.
  if (key === LOCATION_QUERY_KEY && Object.hasOwn(query, 'location')) {
    const nested = query.location;
    if (isRecord(nested)) {
      if (Object.hasOwn(nested, 'directory')) values.push(nested.directory);
    } else if (nested !== undefined) {
      values.push({ invalid: true });
    }
  }
  return values;
};

const readHeaderValues = (headers) => {
  if (headers === undefined || headers === null) return [];
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    const value = headers.get(LOCATION_HEADER);
    return value === null ? [] : [{ header: value }];
  }
  if (!isRecord(headers)) return [{ invalid: true }];
  const values = [];
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === LOCATION_HEADER) values.push(typeof value === 'string' ? { header: value } : { invalid: true });
  }
  return values;
};

const hasDotDotSegment = (value) => value.split(/[\\/]+/).some((segment) => segment === '..');

const normalizeDirectory = (value) => {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || hasControlCharacter(value)) return null;
  if (!path.isAbsolute(value) || hasDotDotSegment(value)) return null;
  return path.resolve(value);
};

const isWithinRoot = (directory, root) => {
  const relative = path.relative(root, directory);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

/**
 * Validates every directory a request names (`location[directory]` query,
 * `x-opencode-directory` header, the session-list `directory` query and a
 * create body's `location.directory`) against the allowed project roots.
 *
 * - All named directories must be absolute, free of `..`, agree with each
 *   other and lie inside (or equal) an allowed root.
 * - `header`-mode operations must name one; `body-location` operations must
 *   name one in the body or the header.
 * Lexical only: symlink resolution is the caller's responsibility.
 *
 * @param {{ method?: string, path?: string, route?: object, query?: unknown, headers?: unknown, body?: unknown,
 *   allowedRoots: Iterable<string> }} input
 * @returns {{ ok: true, directory: string | null, mode: string } | { ok: false, code: string, mode: string | null }}
 */
export const bindOpenCodeV2Location = ({ method, path: target, route, query, headers, body, allowedRoots } = {}) => {
  let resolvedRoute = route ?? null;
  let effectiveQuery = query;
  if (!resolvedRoute) {
    const match = matchOpenCodeV2Route(method, target);
    if (!match.ok) return { ok: false, code: 'route_unknown', mode: null };
    resolvedRoute = match.route;
    if (effectiveQuery === undefined && match.search) effectiveQuery = match.search;
  }
  const mode = resolvedRoute.location;
  const roots = [];
  for (const root of allowedRoots ?? []) {
    const normalized = normalizeDirectory(root);
    if (normalized) roots.push(normalized);
  }

  const raw = [
    ...readQueryValues(effectiveQuery, LOCATION_QUERY_KEY),
    ...readHeaderValues(headers),
    ...readQueryValues(effectiveQuery, 'directory'),
  ];
  if (mode === 'body-location' && isRecord(body) && body.location !== undefined && body.location !== null) {
    if (!isRecord(body.location)) return { ok: false, code: 'location_invalid', mode };
    if (body.location.directory !== undefined && body.location.directory !== null) raw.push(body.location.directory);
  }

  const directories = [];
  for (const value of raw) {
    let candidate = value;
    if (isRecord(candidate) && candidate.invalid) return { ok: false, code: 'location_invalid', mode };
    if (isRecord(candidate) && typeof candidate.header === 'string') {
      try {
        candidate = decodeURIComponent(candidate.header); // v2 URI-decodes the header
      } catch {
        return { ok: false, code: 'location_invalid', mode };
      }
    }
    if (candidate === undefined || candidate === null || candidate === '') continue;
    const normalized = normalizeDirectory(candidate);
    if (!normalized) return { ok: false, code: 'location_invalid', mode };
    directories.push(normalized);
  }

  if (new Set(directories).size > 1) return { ok: false, code: 'location_ambiguous', mode };
  const directory = directories[0] ?? null;
  if (directory === null) {
    if (mode === 'header' || mode === 'body-location') return { ok: false, code: 'location_required', mode };
    return { ok: true, directory: null, mode };
  }
  if (!roots.some((root) => isWithinRoot(directory, root))) return { ok: false, code: 'location_outside_roots', mode };
  return { ok: true, directory, mode };
};

// ---------------------------------------------------------------------------
// Live drift check: the host's `/openapi.json` against the generated table.

const DRIFT_FIELDS = ['operationId', 'location', 'pathParams', 'query', 'body', 'stream'];

/**
 * Compares a live OpenAPI document with the generated table. Any added,
 * removed or changed operation is drift; on the pinned version drift blocks
 * gen-2 readiness.
 *
 * @returns {{ ok: boolean, version: string, sha256: string, error: string | null,
 *   added: string[], removed: string[], changed: { route: string, fields: string[] }[] }}
 */
export const diffLiveSpec = (openapiJson, { routes = OPENCODE_V2_ROUTES } = {}) => {
  const result = { ok: false, version: OPENCODE_V2_ROUTES_VERSION, sha256: OPENCODE_V2_OPENAPI_SHA256, error: null, added: [], removed: [], changed: [] };
  let doc = openapiJson;
  if (typeof doc === 'string') {
    try {
      doc = JSON.parse(doc);
    } catch {
      return { ...result, error: 'openapi_unparseable' };
    }
  }
  let live;
  try {
    live = extractOpenCodeV2Operations(doc);
  } catch (error) {
    return { ...result, error: `openapi_invalid: ${error instanceof Error ? error.message : String(error)}` };
  }
  const expected = new Map(routes.map((route) => [openCodeV2RouteKey(route.method, route.template), route]));
  const actual = new Map(live.map((route) => [openCodeV2RouteKey(route.method, route.template), route]));
  for (const [key, route] of actual) {
    const known = expected.get(key);
    if (!known) {
      result.added.push(key);
      continue;
    }
    const fields = DRIFT_FIELDS.filter((field) => JSON.stringify(known[field]) !== JSON.stringify(route[field]));
    if (fields.length > 0) result.changed.push({ route: key, fields });
  }
  for (const key of expected.keys()) {
    if (!actual.has(key)) result.removed.push(key);
  }
  result.added.sort();
  result.removed.sort();
  result.ok = result.added.length === 0 && result.removed.length === 0 && result.changed.length === 0;
  return result;
};
