// OpenCode 2 readiness requires the owned host's exact version, catalog and
// migration proof at /devryan/ready, plus its /api/info response. Unsupported
// generations fail before any request. Authentication covers both routes.

import { readOpenCodeRuntimeSelection } from './runtime-selection.js';
import { OPENCODE_V2_ROUTES_VERSION } from './v2/routes.generated.js';
import { resolveQaTargetOpenCodeVersion } from './version-policy.js';
import { readResponseBody } from './opencode-client/envelope.js';

export const OPENCODE_GENERATION_ENV = 'DEVRYAN_OPENCODE_GENERATION';

/**
 * The OpenCode 2.x version the gen-2 host must embed. It is the version of the
 * vendored OpenAPI document the route table was generated from, so the route
 * policy and the readiness pin cannot disagree.
 */
export const TARGET_OPENCODE_V2_VERSION = OPENCODE_V2_ROUTES_VERSION;

export const OPENCODE_READY_PHASES = Object.freeze(['booting', 'migrating', 'catalog_mismatch', 'stopping']);
export const OPENCODE_READY_MIGRATION_STATES = Object.freeze(['completed', 'not-needed']);

/**
 * Why a probe was not ready. `null` on a ready result.
 * @typedef {'generation_invalid' | 'generation_mismatch' | 'unreachable' | 'timeout' | 'unauthorized'
 *   | 'health_status' | 'unhealthy' | 'not_ready' | 'ready_route_missing' | 'ready_status'
 *   | 'invalid_ready_body' | 'catalog_unasserted' | 'version_policy_invalid' | 'version_mismatch'
 *   | 'info_status'} OpenCodeReadinessReason
 */

/**
 * @typedef {{
 *   ready: boolean,
 *   generation: 2 | null,
 *   version: string | null,
 *   expectedVersion: string | null,
 *   reason: OpenCodeReadinessReason | null,
 *   status: number | null,
 *   phase: string | null,
 *   retryAfterMs: number | null,
 *   catalogAsserted: boolean,
 *   host: { version: string, buildId: string } | null,
 *   migration: string | null,
 * }} OpenCodeReadinessResult
 */

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const trimmedString = (value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null);

/**
 * Only OpenCode 2 is supported (number or exact string), else null.
 * @param {unknown} value
 * @returns {2 | null}
 */
export const parseOpenCodeGeneration = (value) => {
  if (value === 2) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '2') return 2;
  return null;
};

/**
 * The only supported target is OpenCode 2. An explicit unsupported declaration
 * fails closed; the readiness probe still verifies the actual host identity.
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ generation: 2 | null, source: 'default' | 'DEVRYAN_OPENCODE_GENERATION' | 'invalid' }}
 */
export const resolveExternalOpenCodeGeneration = (env = process.env) => {
  const raw = env?.[OPENCODE_GENERATION_ENV];
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return { generation: 2, source: 'default' };
  }
  const generation = parseOpenCodeGeneration(raw);
  if (generation === null) return { generation: null, source: 'invalid' };
  return { generation, source: OPENCODE_GENERATION_ENV };
};

/**
 * The generation of the runtime this server launched, from the selection it
 * recorded. Missing, foreign and unsupported selections cannot identify a ready host.
 * @param {{ readSelection?: typeof readOpenCodeRuntimeSelection, ownerPid?: number }} [options]
 * @returns {{ generation: 2 | null, source: 'selection' | 'invalid' }}
 */
export const resolveManagedOpenCodeGeneration = ({
  readSelection = readOpenCodeRuntimeSelection,
  ownerPid = process.pid,
} = {}) => {
  const selection = readSelection();
  if (selection && selection.ownerPid === ownerPid) {
    const generation = parseOpenCodeGeneration(selection.runtime?.generation);
    if (generation !== null) return { generation, source: 'selection' };
  }
  return { generation: null, source: 'invalid' };
};

/**
 * The exact OpenCode 2 version required by the host or explicit QA candidate.
 * @param {2} generation
 * @param {Record<string, string | undefined>} [env]
 * @returns {string | null}
 */
export const resolveExpectedOpenCodeVersion = (generation, env = process.env) => {
  if (generation !== 2) throw new Error('Only OpenCode 2 is supported');
  return resolveQaTargetOpenCodeVersion(env).version;
};

const notReady = (generation, reason, extra = {}) => ({
  ready: false,
  generation,
  version: null,
  expectedVersion: null,
  reason,
  status: null,
  phase: null,
  retryAfterMs: null,
  catalogAsserted: false,
  host: null,
  migration: null,
  ...extra,
});

const joinUrl = (baseUrl, route) => `${String(baseUrl).replace(/\/+$/, '')}${route}`;

const isAbortError = (error) => error?.name === 'AbortError' || error?.name === 'TimeoutError';

const fetchJson = async (fetchImpl, url, headers, signal, readOptions = {}) => {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...headers },
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (readOptions.propagateReadFailures) {
      signal?.throwIfAborted();
      if (error?.code === 'opencode_runtime_changed') throw error;
    }
    return { error: isAbortError(error) ? 'timeout' : 'unreachable' };
  }
  const status = typeof response?.status === 'number' ? response.status : null;
  if (readOptions.propagateReadFailures || readOptions.maxResponseBytes !== undefined || readOptions.onResponseRead !== undefined) {
    try {
      const read = await readResponseBody(response, { ...readOptions, signal });
      return { ok: response.ok, status, body: read.parsed ? read.value : null };
    } catch (error) {
      if (readOptions.propagateReadFailures) throw error;
      return { error: isAbortError(error) ? 'timeout' : 'unreachable' };
    }
  }
  if (!response?.ok) return { ok: false, status, body: null, response };
  const body = await response.json().catch(() => null);
  return { ok: true, status, body };
};

const readNotReadyBody = async (response, alreadyRead) => {
  const body = alreadyRead ?? (response && typeof response.json === 'function' ? await response.json().catch(() => null) : null);
  const phase = isRecord(body) && OPENCODE_READY_PHASES.includes(body.phase) ? body.phase : null;
  const retryAfterMs = isRecord(body) && Number.isSafeInteger(body.retryAfterMs) && body.retryAfterMs >= 0
    ? body.retryAfterMs
    : null;
  return { phase, retryAfterMs };
};

const probeGenerationTwo = async ({ fetchImpl, baseUrl, headers, signal, env, expectedVersion, readOptions }) => {
  const settled = await Promise.allSettled([
    fetchJson(fetchImpl, joinUrl(baseUrl, '/devryan/ready'), headers, signal, readOptions),
    fetchJson(fetchImpl, joinUrl(baseUrl, '/api/info'), headers, signal, readOptions),
  ].map((pending) => pending.catch((error) => {
    readOptions.cancelPending?.(error);
    throw error;
  })));
  if (settled[0].status === 'rejected') throw settled[0].reason;
  if (settled[1].status === 'rejected') throw settled[1].reason;
  const readyResult = settled[0].value;
  const infoResult = settled[1].value;


  if (readyResult.error) return notReady(2, readyResult.error);
  if (readyResult.status === 401 || infoResult.status === 401) {
    return notReady(2, 'unauthorized', { status: 401 });
  }
  if (!readyResult.ok) {
    if (readyResult.status === 503) {
      const { phase, retryAfterMs } = await readNotReadyBody(readyResult.response, readyResult.body);
      return notReady(2, 'not_ready', { status: 503, phase, retryAfterMs });
    }
    // A runtime without the host route is not the DevRyan gen-2 host.
    const reason = readyResult.status === 404 ? 'ready_route_missing' : 'ready_status';
    return notReady(2, reason, { status: readyResult.status });
  }

  const body = readyResult.body;
  const status = readyResult.status;
  if (!isRecord(body) || body.ready !== true) return notReady(2, 'invalid_ready_body', { status });
  if (body.generation !== 2) return notReady(2, 'generation_mismatch', { status });
  const version = isRecord(body.opencode) ? trimmedString(body.opencode.version) : null;
  const hostVersion = isRecord(body.host) ? trimmedString(body.host.version) : null;
  const buildId = isRecord(body.host) ? trimmedString(body.host.buildId) : null;
  const migration = isRecord(body.migration) && OPENCODE_READY_MIGRATION_STATES.includes(body.migration.v1)
    ? body.migration.v1
    : null;
  if (!version || !hostVersion || !buildId || !migration || !isRecord(body.catalog)) {
    return notReady(2, 'invalid_ready_body', { status, version });
  }
  const host = { version: hostVersion, buildId };
  if (body.catalog.asserted !== true) {
    return notReady(2, 'catalog_unasserted', { status, version, host, migration });
  }

  let expected = expectedVersion;
  if (expected === undefined) {
    try {
      expected = resolveExpectedOpenCodeVersion(2, env);
    } catch {
      return notReady(2, 'version_policy_invalid', { status, version, host, migration, catalogAsserted: true });
    }
  }
  if (version !== expected) {
    return notReady(2, 'version_mismatch', {
      status, version, expectedVersion: expected, host, migration, catalogAsserted: true,
    });
  }

  if (infoResult.error) return notReady(2, infoResult.error, { version, expectedVersion: expected, host, migration });
  if (!infoResult.ok) {
    return notReady(2, 'info_status', {
      status: infoResult.status, version, expectedVersion: expected, host, migration, catalogAsserted: true,
    });
  }
  const infoVersion = isRecord(infoResult.body) ? trimmedString(infoResult.body.version) : null;
  if (infoVersion && EXACT_VERSION.test(infoVersion) && infoVersion !== version) {
    return notReady(2, 'version_mismatch', {
      status: infoResult.status, version: infoVersion, expectedVersion: expected, host, migration, catalogAsserted: true,
    });
  }

  return {
    ready: true,
    generation: 2,
    version,
    expectedVersion: expected,
    reason: null,
    status,
    phase: null,
    retryAfterMs: null,
    catalogAsserted: true,
    host,
    migration,
  };
};

/**
 * Probes one OpenCode runtime once. Lifecycle calls report network failures,
 * timeouts and malformed answers as not-ready. The generation client opts
 * into propagating read failures so caller budgets and cancellation survive.
 *
 * @param {{
 *   generation: 2 | null,
 *   baseUrl: string,
 *   headers?: Record<string, string>,
 *   fetchImpl?: typeof fetch,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 *   maxResponseBytes?: number,
 *   onResponseRead?: (event: { phase: 'start' | 'chunk' | 'end', bytes: number }) => void,
 *   propagateReadFailures?: boolean,
 *   expectedVersion?: string,
 *   env?: Record<string, string | undefined>,
 * }} options `signal` bounds both requests; otherwise `timeoutMs` (when
 *   positive) arms an internal abort timer that is always cleared.
 *   `expectedVersion` overrides the gen-2 pin (tests).
 * @returns {Promise<OpenCodeReadinessResult>}
 */
export const probe = async ({
  generation,
  baseUrl,
  headers = {},
  fetchImpl = (...args) => globalThis.fetch(...args),
  signal,
  timeoutMs,
  maxResponseBytes,
  onResponseRead,
  propagateReadFailures = false,
  expectedVersion,
  env = process.env,
} = {}) => {
  const resolvedGeneration = parseOpenCodeGeneration(generation);
  if (resolvedGeneration === null) return notReady(null, 'generation_invalid');
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) return notReady(resolvedGeneration, 'unreachable');

  let controller = propagateReadFailures ? new AbortController() : null;
  let timer = null;
  if ((!signal || propagateReadFailures) && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    controller ??= new AbortController();
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }
  const effectiveSignal = signal && controller ? AbortSignal.any([signal, controller.signal]) : signal ?? controller?.signal;
  const readOptions = { maxResponseBytes, onResponseRead, propagateReadFailures,
    cancelPending: controller ? (error) => controller.abort(error) : undefined };
  try {
    if (propagateReadFailures) effectiveSignal?.throwIfAborted();
    return await probeGenerationTwo({ fetchImpl, baseUrl, headers, signal: effectiveSignal, env, expectedVersion, readOptions });
  } catch (error) {
    if (propagateReadFailures) throw error;
    return notReady(resolvedGeneration, 'unreachable');
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** Capability flags the UI reads from `/health` (`openCode.capabilities`). */
export const OPENCODE_RUNTIME_CAPABILITY_KEYS = Object.freeze(['share', 'mcpOAuth', 'sessionShell', 'lsp', 'messageEdit']);

// Gen 2 defaults closed. The owned host may qualify its MCP OAuth facade;
// share, LSP, message edit and the public session shell remain unavailable.
const UNAVAILABLE_CAPABILITIES = Object.freeze({
  share: false, mcpOAuth: false, sessionShell: false, lsp: false, messageEdit: false,
});

/**
 * The `/health` snapshot block for the runtime generation. An unknown
 * generation reports nothing as available (fail closed).
 * @param {unknown} generation
 * @returns {{ generation: 2 | null, capabilities: Readonly<Record<string, boolean>> }}
 */
export const describeOpenCodeRuntimeCapabilities = (generation, { mcpOAuthAvailable = false } = {}) => {
  const resolved = parseOpenCodeGeneration(generation);
  return {
    generation: resolved,
    capabilities: resolved === 2 && mcpOAuthAvailable === true ? { ...UNAVAILABLE_CAPABILITIES, mcpOAuth: true } : UNAVAILABLE_CAPABILITIES,
  };
};
