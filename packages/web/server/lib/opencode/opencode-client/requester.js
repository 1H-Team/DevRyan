// ---------------------------------------------------------------------------
// The gen-2 HTTP requester (DESIGN.md C.1, C.3, C.6).
//
// Per request:
//   1. path mapping: a concrete 2.0.20 path (`/api/...`) or a DevRyan host
//      route (`/devryan/...`, C.6). Both are normalized first: `..`, encoded
//      separators, backslashes and control characters are refused, and the
//      upstream sees the canonical path;
//   2. location translation from the route's declared mode (location.js); a
//      location-scoped operation without a directory fails closed with
//      `opencode_location_required` before any I/O;
//   3. the route policy (`v2/route-policy.js`) for the requester's audience;
//      host routes use the table below. A denied request is never sent;
//   4. optional root binding (`policy.allowedRoots`), for `/api/*` and host
//      routes alike;
//   5. typed errors (errors.js) and envelope reading (envelope.js).
//
// Privilege boundary (C.1): this module can build a `privileged` requester, so
// only the client internals (`v2.js` for the scoped archive write and
// `privileged.js`) and the allowlisted privileged modules may import it;
// `opencode-client.contract.test.js` enforces that. `v2.js` exports a
// server-only wrapper for everyone else. The route policy is not injectable.
// ---------------------------------------------------------------------------

import {
  bindOpenCodeV2Location,
  evaluateOpenCodeV2Request,
  matchOpenCodeV2Route,
  normalizeOpenCodeV2Path,
  OPENCODE_V2_AUDIENCE,
} from '../v2/route-policy.js';
import { NO_CONTENT, readResponseBody } from './envelope.js';
import {
  createInvalidResponseError,
  createOpenCodeClientError,
  createV2HttpError,
  OPENCODE_CLIENT_ERROR_CODES,
} from './errors.js';
import { translateLocation } from './location.js';
import { readOpenCodeRuntime, withOpenCodeRuntime } from './runtime.js';

export const V2_DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

const C = OPENCODE_CLIENT_ERROR_CODES;
const SERVER = OPENCODE_V2_AUDIENCE.SERVER;
const PRIVILEGED = OPENCODE_V2_AUDIENCE.PRIVILEGED;
const AUDIENCE_RANK = Object.freeze({ browser: 0, server: 1, privileged: 2 });

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// ---------------------------------------------------------------------------
// DevRyan host routes (C.6). They are not in the 2.0.20 OpenAPI document, so
// the route policy does not know them; this table is their policy. Patterns
// match the canonical (normalized, re-encoded) path. `bind` is the location
// mode used for root binding.

const hostSessionCreateClass = (body) => (
  isRecord(body) && (body.permissions !== undefined || body.metadata !== undefined) ? PRIVILEGED : SERVER
);

/** A child create names its directory in the body, or inherits the parent's. */
const hostSessionCreateBind = (body) => (isRecord(body) && body.location !== undefined ? 'body-location' : 'none');

/**
 * @type {readonly { method: string, pattern: RegExp, location: string, requireDirectory?: boolean,
 *   classify: (body: unknown) => string, bind: (body: unknown) => string }[]}
 */
const HOST_ROUTES = Object.freeze([
  { method: 'GET', pattern: /^\/devryan\/ready$/, location: 'none', classify: () => SERVER, bind: () => 'none' },
  {
    method: 'GET', pattern: /^\/devryan\/tools$/, location: 'query-directory', requireDirectory: true,
    classify: () => SERVER, bind: () => 'query-directory',
  },
  { method: 'POST', pattern: /^\/devryan\/session$/, location: 'none', classify: hostSessionCreateClass, bind: hostSessionCreateBind },
  {
    method: 'POST', pattern: /^\/devryan\/session\/ses[A-Za-z0-9_-]*\/external-message$/, location: 'none',
    classify: () => PRIVILEGED, bind: () => 'none',
  },
]);

const matchHostRoute = (method, canonicalPath) => (
  HOST_ROUTES.find((route) => route.method === method && route.pattern.test(canonicalPath)) ?? null
);

// ---------------------------------------------------------------------------

const resolveSignal = (options, defaultTimeoutMs) => {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : undefined;
  if (options.signal) {
    return timeoutMs === undefined ? options.signal : AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]);
  }
  return AbortSignal.timeout(timeoutMs ?? defaultTimeoutMs);
};

const toSearch = (query) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
};

const routeDenied = (operation, reason, detail) => createOpenCodeClientError(C.routeDenied, 403,
  `${operation} is not allowed for this OpenCode client (${reason})`, { operation, generation: 2, detail: { reason, ...(detail ?? {}) } });


/**
 * @typedef {object} V2RequestSpec
 * @property {string} label the operation (`sessions.get`, ...), used in errors and diagnostics
 * @property {string} [method]
 * @property {string} path concrete path, ids already encoded
 * @property {Record<string, unknown>} [query]
 * @property {unknown} [body]
 * @property {string} [directory]
 * @property {boolean} [allowNotFound] a 404 resolves to `null`
 * @property {AbortSignal} [signal]
 * @property {number} [timeoutMs]
 * @property {number} [defaultTimeoutMs]
 * @property {number} [maxResponseBytes]
 * @property {(event: { phase: 'start' | 'chunk' | 'end', bytes: number }) => void} [onResponseRead]
 */

/**
 * @typedef {object} V2RequesterDeps
 * @property {() => import('./runtime.js').OpenCodeRuntime} getRuntime
 * @property {() => Record<string, string> | Promise<Record<string, string>>} [getAuthHeaders]
 * @property {typeof fetch} [fetchImpl]
 * @property {{ allowedRoots?: () => Iterable<string> }} [policy]
 * @property {(diagnostic: Record<string, unknown>) => void} [recordDiagnostic]
 * @property {(spec: {operation:string,method:string,path:string,body?:unknown,directory?:string}, action:()=>Promise<unknown>)=>Promise<unknown>} [withNativeWebOperation]
 */

/**
 * The gen-2 HTTP requester for one audience. Resolves to the parsed body,
 * {@link NO_CONTENT} for 204/empty answers, or `null` for an allowed 404. A
 * failure while reading a 2xx body (abort, timeout, reset) rejects; it is never
 * an empty answer.
 * @param {V2RequesterDeps} deps
 * @param {{ audience: 'server' | 'privileged' }} options
 * @returns {(spec: V2RequestSpec) => Promise<unknown>}
 */
export const createV2AudienceRequester = (deps, { audience } = {}) => {
  if (audience !== SERVER && audience !== PRIVILEGED) {
    throw new TypeError('createV2AudienceRequester needs the server or privileged audience');
  }
  const fetchImpl = deps.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  const getAuthHeaders = typeof deps.getAuthHeaders === 'function' ? deps.getAuthHeaders : () => ({});
  const allowedRoots = typeof deps.policy?.allowedRoots === 'function' ? deps.policy.allowedRoots : null;
  const recordDiagnostic = typeof deps.recordDiagnostic === 'function' ? deps.recordDiagnostic : () => {};

  const deny = (operation, reason, detail) => {
    recordDiagnostic({ code: 'opencode_client_route_denied', generation: 2, audience, operation, reason });
    return routeDenied(operation, reason, detail);
  };

  const bindRoots = ({ operation, route, search, headers, body }) => {
    if (!allowedRoots) return;
    const bound = bindOpenCodeV2Location({ route, query: search, headers, body, allowedRoots: allowedRoots() });
    if (bound.ok) return;
    throw createOpenCodeClientError(bound.code === 'location_required' ? C.locationRequired : C.locationInvalid, 400,
      `${operation}: ${bound.code}`, { operation, generation: 2, detail: { reason: bound.code } });
  };

  /** Host routes: normalized path, the table's audience and the same root binding. */
  const resolveHostTarget = (operation, method, spec) => {
    const normalized = normalizeOpenCodeV2Path(spec.path);
    if (!normalized.ok) throw deny(operation, normalized.reason);
    if (normalized.search) throw deny(operation, 'query_in_path');
    const host = matchHostRoute(method, normalized.canonicalPath);
    if (!host) throw deny(operation, 'route_unknown');
    const location = translateLocation({
      mode: host.location,
      directory: spec.directory,
      body: spec.body,
      operation,
      required: host.requireDirectory === true,
    });
    const search = toSearch({ ...(spec.query ?? {}), ...location.query });
    const body = location.body;
    if (AUDIENCE_RANK[host.classify(body)] > AUDIENCE_RANK[audience]) throw deny(operation, 'audience_insufficient');
    bindRoots({ operation, route: { location: host.bind(body) }, search, headers: location.headers, body });
    return { target: `${normalized.canonicalPath}${search}`, headers: location.headers, body };
  };

  /** `/api/*` routes: the generated table, the route policy and root binding. */
  const resolveApiTarget = (operation, method, spec) => {
    const match = matchOpenCodeV2Route(method, spec.path);
    if (!match.ok) throw deny(operation, match.reason);
    const { route } = match;
    const location = translateLocation({ mode: route.location, directory: spec.directory, body: spec.body, operation });
    const search = toSearch({ ...(spec.query ?? {}), ...location.query });
    const body = location.body;
    const decision = evaluateOpenCodeV2Request({ audience, method, path: `${spec.path}${search}`, body });
    if (!decision.allowed) {
      throw deny(operation, decision.reason, decision.keys ? { keys: decision.keys } : undefined);
    }
    bindRoots({ operation, route, search: decision.search, headers: location.headers, body });
    return { target: `${decision.canonicalPath}${decision.search}`, headers: location.headers, body };
  };

  return async (spec) => withOpenCodeRuntime(deps.getRuntime, spec.label, async () => {
    const operation = spec.label;
    const method = (spec.method ?? 'GET').toUpperCase();
    const { target, headers, body } = spec.path.startsWith('/devryan/')
      ? resolveHostTarget(operation, method, spec)
      : resolveApiTarget(operation, method, spec);

    const send = async () => {
    const baseUrl = String(readOpenCodeRuntime(deps.getRuntime).baseUrl ?? '').replace(/\/+$/, '');
    const authHeaders = await getAuthHeaders();
    readOpenCodeRuntime(deps.getRuntime);
    const signal = resolveSignal(spec, spec.defaultTimeoutMs ?? V2_DEFAULT_REQUEST_TIMEOUT_MS);
    const response = await fetchImpl(`${baseUrl}${target}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...authHeaders,
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
    if (!response.ok) {
      const read = await readResponseBody(response, { maxResponseBytes: spec.maxResponseBytes, onResponseRead: spec.onResponseRead, signal });
      if (spec.allowNotFound && response.status === 404) return null;
      throw createV2HttpError({ status: response.status, body: read.value, bodyText: read.text, label: operation });
    }
    const read = await readResponseBody(response, { maxResponseBytes: spec.maxResponseBytes, onResponseRead: spec.onResponseRead, signal });
    if (read.empty) return NO_CONTENT;
    if (!read.parsed) throw createInvalidResponseError({ label: operation, generation: 2 });
    return read.value;
    };
    return deps.withNativeWebOperation
      ? deps.withNativeWebOperation({ operation, method, path: target, body, directory: spec.directory }, send)
      : send();
  });
};
