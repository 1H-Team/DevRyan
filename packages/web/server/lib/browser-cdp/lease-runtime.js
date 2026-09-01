import crypto from 'node:crypto';

import {
  isLoopbackSocketAddress,
  isMatchingDiscoveryToken,
  readBearerToken,
} from './discovery-runtime.js';

export const BROWSER_LEASES_PATH = '/api/desktop/browser-leases';

const DEFAULT_LINEAGE_CACHE_MAX_ENTRIES = 100;
const DEFAULT_LINEAGE_REQUEST_TIMEOUT_MS = 2_000;
const DEFAULT_LINEAGE_RETRY_DELAYS_MS = Object.freeze([100, 300]);
const MAX_LINEAGE_DEPTH = 100;

const requireString = (value, field) => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw new BrowserLeaseError('invalid_request', `${field} is required`, 400);
  }
  return normalized;
};

const normalizeOptionalString = (value) => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized || null;
};

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const setPrivateResponseHeaders = (res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.removeHeader?.('Access-Control-Allow-Origin');
};

const readSessionInfo = (payload) => {
  if (!isRecord(payload)) return null;
  if (isRecord(payload.data)) return payload.data;
  return payload;
};

const readParentID = (session) => {
  if (!isRecord(session)) return undefined;
  for (const field of ['parentID', 'parentId']) {
    if (!Object.prototype.hasOwnProperty.call(session, field)) continue;
    const value = session[field];
    if (value === null || value === undefined || value === '') return null;
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }
  // OpenCode omits parentID for roots. A specific-session response with an ID
  // is therefore authoritative root metadata.
  return typeof session.id === 'string' && session.id.trim() ? null : undefined;
};

const appendDirectory = (url, directory) => {
  const parsed = new URL(url);
  parsed.searchParams.set('directory', directory);
  return parsed.toString();
};

const normalizeHostResult = (result) => {
  const wsUrl = normalizeOptionalString(result?.wsUrl);
  if (!wsUrl) {
    throw new BrowserLeaseError(
      'browser_host_unavailable',
      'The desktop browser host did not provide a lease endpoint',
      503,
    );
  }
  let parsed;
  try {
    parsed = new URL(wsUrl);
  } catch {
    throw new BrowserLeaseError(
      'browser_host_unavailable',
      'The desktop browser host returned an invalid lease endpoint',
      503,
    );
  }
  if (
    (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:')
    || parsed.hostname !== '127.0.0.1'
    || !parsed.port
  ) {
    throw new BrowserLeaseError(
      'browser_host_unavailable',
      'The desktop browser lease endpoint must use private IPv4 loopback',
      503,
    );
  }
  return wsUrl;
};

const extractLifecycleSessionID = (payload) => {
  if (!isRecord(payload) || !['session.idle', 'session.deleted', 'session.error'].includes(payload.type)) {
    return null;
  }
  const properties = isRecord(payload.properties) ? payload.properties : {};
  const info = isRecord(properties.info) ? properties.info : {};
  if (payload.type === 'session.deleted') {
    return normalizeOptionalString(
      info.id
      ?? info.sessionID
      ?? info.sessionId
      ?? properties.sessionID
      ?? properties.sessionId,
    );
  }
  return normalizeOptionalString(
    properties.sessionID
    ?? properties.sessionId
    ?? info.id
    ?? info.sessionID
    ?? info.sessionId,
  );
};

export class BrowserLeaseError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'BrowserLeaseError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export const createBrowserLeaseRuntime = (options = {}) => {
  const getDiscoveryToken = options.getDiscoveryToken ?? (() => '');
  const createBrowserLease = options.createBrowserLease;
  const touchBrowserLease = options.touchBrowserLease;
  const releaseBrowserLease = options.releaseBrowserLease;
  const getBrowserLeaseAvailability = options.getBrowserLeaseAvailability;
  const resolveBrowserLeaseContext = options.resolveBrowserLeaseContext;
  const onObservationChanged = options.onObservationChanged;
  const buildOpenCodeUrl = options.buildOpenCodeUrl;
  const getOpenCodeAuthHeaders = options.getOpenCodeAuthHeaders ?? (() => ({}));
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const createLeaseID = options.createLeaseID
    ?? (() => `dvr_lease_${crypto.randomBytes(18).toString('base64url')}`);
  const createFence = options.createFence
    ?? (() => `dvr_lease_fence_${crypto.randomBytes(18).toString('base64url')}`);
  const lineageCacheMaxEntries = options.lineageCacheMaxEntries ?? DEFAULT_LINEAGE_CACHE_MAX_ENTRIES;
  const lineageRequestTimeoutMs = options.lineageRequestTimeoutMs ?? DEFAULT_LINEAGE_REQUEST_TIMEOUT_MS;
  const lineageRetryDelaysMs = options.lineageRetryDelaysMs ?? DEFAULT_LINEAGE_RETRY_DELAYS_MS;

  const leasesByID = new Map();
  const leaseIDByReuseKey = new Map();
  const lineageCache = new Map();
  const lineageFetches = new Map();
  const lineageControllers = new Set();
  const keyTails = new Map();
  const activeAcquisitions = new Set();
  let shuttingDown = false;
  let admissionEpoch = 0;
  let activeReset = null;

  const emitObservationChanged = (record) => {
    try {
      onObservationChanged?.({
        leaseId: record?.leaseId,
        ownerUserId: record?.metadata?.ownerUserId,
      });
    } catch {
    }
  };

  const runExclusiveForKey = (key, operation) => {
    const previous = keyTails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    const tail = next.then(() => undefined, () => undefined).finally(() => {
      if (keyTails.get(key) === tail) keyTails.delete(key);
    });
    keyTails.set(key, tail);
    return next;
  };

  const admissionError = () => {
    if (shuttingDown) {
      return new BrowserLeaseError('browser_runtime_stopping', 'Browser lease runtime is stopping', 503);
    }
    return new BrowserLeaseError('browser_runtime_resetting', 'Browser lease runtime is restarting', 503);
  };

  const assertAdmission = (epoch) => {
    if (shuttingDown || activeReset || epoch !== admissionEpoch) throw admissionError();
  };

  const readAvailability = async () => {
    if (typeof getBrowserLeaseAvailability !== 'function') return { available: true };
    let value;
    try {
      value = await getBrowserLeaseAvailability();
    } catch {
      throw new BrowserLeaseError('browser_unavailable', 'Agent browser control is unavailable', 503);
    }
    const state = normalizeOptionalString(value?.state ?? value);
    const disabled = value === false
      || value?.available === false
      || state === 'disabled'
      || state === 'agent_browser_disabled';
    if (disabled) {
      throw new BrowserLeaseError('agent_browser_disabled', 'Agent browser control is disabled', 403);
    }
    return { available: true };
  };

  const classifyHostError = (error) => {
    if (error instanceof BrowserLeaseError) return error;
    const code = normalizeOptionalString(error?.code ?? error?.message ?? error);
    if (code === 'agent_browser_disabled') {
      return new BrowserLeaseError('agent_browser_disabled', 'Agent browser control is disabled', 403);
    }
    if (code === 'browser_runtime_stopping') {
      return new BrowserLeaseError('browser_runtime_stopping', 'Browser lease runtime is stopping', 503);
    }
    if (code === 'browser_lease_window_unavailable') {
      return new BrowserLeaseError(
        'browser_owner_context_unavailable',
        'No desktop window currently owns this browser session context',
        503,
      );
    }
    return null;
  };

  const lineageKeyFor = (directory, sessionID) => `${directory}\u0000${sessionID}`;

  const putLineageCache = (directory, sessionID, parentID) => {
    const cacheKey = lineageKeyFor(directory, sessionID);
    lineageCache.delete(cacheKey);
    lineageCache.set(cacheKey, {
      parentID,
    });
    while (lineageCache.size > lineageCacheMaxEntries) {
      lineageCache.delete(lineageCache.keys().next().value);
    }
  };

  const getCachedParentID = (directory, sessionID) => {
    const cacheKey = lineageKeyFor(directory, sessionID);
    const cached = lineageCache.get(cacheKey);
    if (!cached) return undefined;
    lineageCache.delete(cacheKey);
    lineageCache.set(cacheKey, cached);
    return cached.parentID;
  };

  const fetchParentIDUncached = async (sessionID, directory) => {
    if (typeof buildOpenCodeUrl !== 'function') {
      throw new BrowserLeaseError(
        'lineage_unavailable',
        'Session lineage is unavailable in this runtime',
        503,
      );
    }

    const controller = new AbortController();
    lineageControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(new Error('Session lineage lookup timed out')), lineageRequestTimeoutMs);
    timeout.unref?.();
    try {
      const baseUrl = buildOpenCodeUrl(`/session/${encodeURIComponent(sessionID)}`, '');
      const response = await fetchImpl(appendDirectory(baseUrl, directory), {
        method: 'GET',
        headers: {
          accept: 'application/json',
          ...getOpenCodeAuthHeaders(),
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = new BrowserLeaseError(
          'lineage_unavailable',
          `Cannot resolve session lineage (${response.status})`,
          503,
        );
        error.transient = response.status >= 500;
        throw error;
      }
      const session = readSessionInfo(await response.json().catch(() => null));
      if (normalizeOptionalString(session?.id) !== sessionID) {
        throw new BrowserLeaseError(
          'lineage_unavailable',
          'OpenCode returned mismatched session lineage metadata',
          503,
        );
      }
      const parentID = readParentID(session);
      if (parentID === undefined) {
        throw new BrowserLeaseError(
          'lineage_unavailable',
          'OpenCode returned incomplete session lineage metadata',
          503,
        );
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      putLineageCache(directory, sessionID, parentID);
      return parentID;
    } catch (error) {
      if (error instanceof BrowserLeaseError) throw error;
      const unavailable = new BrowserLeaseError(
        'lineage_unavailable',
        'Cannot resolve session lineage from OpenCode',
        503,
      );
      unavailable.transient = true;
      throw unavailable;
    } finally {
      clearTimeout(timeout);
      lineageControllers.delete(controller);
    }
  };

  const fetchParentIDWithRetry = async (sessionID, directory) => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fetchParentIDUncached(sessionID, directory);
      } catch (error) {
        const delay = error?.transient === true ? lineageRetryDelaysMs[attempt] : undefined;
        if (!Number.isFinite(delay)) throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  };

  const fetchParentID = (sessionID, directory) => {
    const cached = getCachedParentID(directory, sessionID);
    if (cached !== undefined) return cached;
    const lineageKey = lineageKeyFor(directory, sessionID);
    const existing = lineageFetches.get(lineageKey);
    if (existing) return existing;
    const request = fetchParentIDWithRetry(sessionID, directory);
    const shared = request.then(
      (value) => {
        if (lineageFetches.get(lineageKey) === shared) lineageFetches.delete(lineageKey);
        return value;
      },
      (error) => {
        if (lineageFetches.get(lineageKey) === shared) lineageFetches.delete(lineageKey);
        throw error;
      },
    );
    lineageFetches.set(lineageKey, shared);
    return shared;
  };

  const resolveRootSessionID = async ({ opencodeSessionID, directory }) => {
    const seen = new Set();
    let current = opencodeSessionID;
    for (let depth = 0; depth < MAX_LINEAGE_DEPTH; depth += 1) {
      if (seen.has(current)) {
        throw new BrowserLeaseError('lineage_cycle', 'Session lineage contains a cycle', 409);
      }
      seen.add(current);
      const parentID = await fetchParentID(current, directory);
      if (!parentID) return current;
      current = parentID;
    }
    throw new BrowserLeaseError('lineage_too_deep', 'Session lineage exceeds the supported depth', 409);
  };

  const parseScope = (value) => {
    if (!isRecord(value)) {
      throw new BrowserLeaseError('invalid_request', 'Request body must be an object', 400);
    }
    return {
      opencodeSessionID: requireString(value.opencodeSessionID, 'opencodeSessionID'),
      messageID: requireString(value.messageID, 'messageID'),
      directory: requireString(value.directory, 'directory'),
      agent: normalizeOptionalString(value.agent),
    };
  };

  const reuseKeyFor = (scope) => `${scope.opencodeSessionID}\u0000${scope.messageID}`;

  const publicLease = (record, created) => ({
    leaseId: record.leaseId,
    wsUrl: record.wsUrl,
    created,
    generation: record.generation,
    previewUrl: normalizeOptionalString(record.metadata.previewUrl),
    serviceTokenConfigured: record.metadata.serviceTokenConfigured === true,
  });

  const removeRecordLocked = (record) => {
    if (leasesByID.get(record.leaseId)?.fence !== record.fence) return false;
    leasesByID.delete(record.leaseId);
    if (leaseIDByReuseKey.get(record.reuseKey) === record.leaseId) {
      leaseIDByReuseKey.delete(record.reuseKey);
    }
    return true;
  };

  const handleHostClosed = async (leaseId, fence, reason = 'host_closed') => {
    const record = leasesByID.get(leaseId);
    if (!record || record.fence !== fence) return false;
    return await runExclusiveForKey(record.reuseKey, async () => {
      const current = leasesByID.get(leaseId);
      if (!current || current.fence !== fence) return false;
      const removed = removeRecordLocked(current);
      if (removed) emitObservationChanged(current);
      return removed;
    });
  };

  const acquireInternal = async (input) => {
    const epoch = admissionEpoch;
    assertAdmission(epoch);
    if (typeof createBrowserLease !== 'function') {
      throw new BrowserLeaseError('browser_unavailable', 'Agent browser control is unavailable', 503);
    }
    const scope = parseScope(input);
    const reuseKey = reuseKeyFor(scope);
    return await runExclusiveForKey(reuseKey, async () => {
      assertAdmission(epoch);
      const existingID = leaseIDByReuseKey.get(reuseKey);
      const existing = existingID ? leasesByID.get(existingID) : null;
      try {
        await readAvailability();
      } catch (error) {
        assertAdmission(epoch);
        if (error instanceof BrowserLeaseError && error.code === 'agent_browser_disabled' && existing) {
          if (removeRecordLocked(existing)) emitObservationChanged(existing);
          try {
            await releaseBrowserLease?.({ leaseId: existing.leaseId, reason: 'agent_browser_disabled' });
          } catch {
          }
          assertAdmission(epoch);
        }
        throw error;
      }
      assertAdmission(epoch);
      if (existing?.wsUrl) {
        requireMatchingScope(existing, scope);
        return publicLease(existing, false);
      }
      if (existing) removeRecordLocked(existing);

      let rootSessionId;
      try {
        rootSessionId = await resolveRootSessionID(scope);
      } catch (error) {
        assertAdmission(epoch);
        throw error;
      }
      assertAdmission(epoch);
      await readAvailability();
      assertAdmission(epoch);
      let resolvedContext = null;
      if (typeof resolveBrowserLeaseContext === 'function') {
        try {
          resolvedContext = await resolveBrowserLeaseContext({
            rootSessionId,
            opencodeSessionID: scope.opencodeSessionID,
            directory: scope.directory,
            agent: scope.agent,
          });
        } catch (error) {
          assertAdmission(epoch);
          const code = normalizeOptionalString(error?.code) || 'browser_owner_context_unavailable';
          const message = normalizeOptionalString(error?.message) || 'Browser owner context is unavailable';
          throw new BrowserLeaseError(code, message, Number(error?.statusCode) || 503);
        }
      }
      assertAdmission(epoch);
      const leaseId = createLeaseID();
      const fence = createFence();
      const timestamp = now();
      const generation = timestamp;
      const metadata = Object.freeze({
        ...(isRecord(resolvedContext?.metadata) ? resolvedContext.metadata : {}),
        rootSessionId,
        opencodeSessionID: scope.opencodeSessionID,
        messageID: scope.messageID,
        directory: scope.directory,
        agent: scope.agent,
      });
      const record = {
        leaseId,
        fence,
        reuseKey,
        generation,
        metadata,
        wsUrl: null,
        createdAt: timestamp,
        lastActivityAt: timestamp,
      };
      leasesByID.set(leaseId, record);
      leaseIDByReuseKey.set(reuseKey, leaseId);

      try {
        const result = await createBrowserLease({
          leaseId,
          metadata,
          previewCredential: isRecord(resolvedContext?.credential)
            ? resolvedContext.credential
            : null,
          onClosed: (reason) => {
            void handleHostClosed(leaseId, fence, reason).catch(() => undefined);
          },
        });
        const current = leasesByID.get(leaseId);
        if (!current || current.fence !== fence) {
          throw new BrowserLeaseError('browser_lease_closed', 'Browser lease closed while starting', 409);
        }
        assertAdmission(epoch);
        current.wsUrl = normalizeHostResult(result);
        current.lastActivityAt = now();
        emitObservationChanged(current);
        return publicLease(current, true);
      } catch (error) {
        const current = leasesByID.get(leaseId);
        if (current?.fence === fence) removeRecordLocked(current);
        try {
          await releaseBrowserLease?.({ leaseId, reason: 'create_failed' });
        } catch {
        }
        assertAdmission(epoch);
        const classified = classifyHostError(error);
        if (classified) throw classified;
        throw new BrowserLeaseError(
          'browser_host_unavailable',
          'The desktop browser host could not create a lease',
          503,
        );
      }
    });
  };

  const acquire = (input) => {
    const operation = acquireInternal(input);
    activeAcquisitions.add(operation);
    const cleanup = () => activeAcquisitions.delete(operation);
    void operation.then(cleanup, cleanup);
    return operation;
  };

  const requireMatchingScope = (record, scope) => {
    if (
      record.metadata.opencodeSessionID !== scope.opencodeSessionID
      || record.metadata.messageID !== scope.messageID
      || record.metadata.directory !== scope.directory
      || normalizeOptionalString(record.metadata.agent) !== scope.agent
    ) {
      throw new BrowserLeaseError('browser_lease_scope_mismatch', 'Browser lease scope does not match', 403);
    }
  };

  const touch = async (leaseIdInput, input) => {
    const leaseId = requireString(leaseIdInput, 'leaseId');
    const scope = parseScope(input);
    const record = leasesByID.get(leaseId);
    if (!record) throw new BrowserLeaseError('browser_lease_not_found', 'Browser lease was not found', 404);
    return await runExclusiveForKey(record.reuseKey, async () => {
      const current = leasesByID.get(leaseId);
      if (!current || current.fence !== record.fence) {
        throw new BrowserLeaseError('browser_lease_not_found', 'Browser lease was not found', 404);
      }
      requireMatchingScope(current, scope);
      const hostTouchResult = await touchBrowserLease?.({ leaseId, metadata: current.metadata });
      const hostLeaseMissing = hostTouchResult === false
        || hostTouchResult?.ok === false
        || hostTouchResult?.state === 'not_found'
        || hostTouchResult?.state === 'missing';
      if (hostLeaseMissing) {
        if (removeRecordLocked(current)) emitObservationChanged(current);
        throw new BrowserLeaseError('browser_lease_not_found', 'Browser lease was not found', 404);
      }
      if (leasesByID.get(leaseId)?.fence !== current.fence) {
        throw new BrowserLeaseError('browser_lease_not_found', 'Browser lease was not found', 404);
      }
      current.lastActivityAt = now();
      emitObservationChanged(current);
      return { leaseId, touched: true };
    });
  };

  const releaseRecord = async (record, reason) => {
    const removed = await runExclusiveForKey(record.reuseKey, async () => {
      const current = leasesByID.get(record.leaseId);
      if (!current || current.fence !== record.fence) return false;
      return removeRecordLocked(current);
    });
    if (!removed) return false;
    emitObservationChanged(record);
    try {
      await releaseBrowserLease?.({ leaseId: record.leaseId, reason });
    } catch {
      // The server record is authoritative. A failed host cleanup remains
      // visible to the Electron owner and must never resurrect this lease.
    }
    return true;
  };

  const release = async (leaseIdInput, input, reason = 'agent_close') => {
    const leaseId = requireString(leaseIdInput, 'leaseId');
    const record = leasesByID.get(leaseId);
    if (!record) return { leaseId, released: false };
    const scope = parseScope(input);
    requireMatchingScope(record, scope);
    return { leaseId, released: await releaseRecord(record, reason) };
  };

  const releaseByOpenCodeSession = async (opencodeSessionID, reason = 'session_terminal') => {
    const normalized = normalizeOptionalString(opencodeSessionID);
    if (!normalized) return 0;
    const records = [...leasesByID.values()].filter(
      (record) => record.metadata.opencodeSessionID === normalized,
    );
    const results = await Promise.all(records.map((record) => releaseRecord(record, reason)));
    return results.filter(Boolean).length;
  };

  const processOpenCodeEvent = async (payload) => {
    const sessionID = extractLifecycleSessionID(payload);
    if (!sessionID) return 0;
    if (payload.type === 'session.deleted') {
      for (const key of lineageCache.keys()) {
        if (key.endsWith(`\u0000${sessionID}`)) lineageCache.delete(key);
      }
    }
    return await releaseByOpenCodeSession(sessionID, payload.type);
  };

  const pauseForReset = (reason = 'runtime_reset') => {
    if (shuttingDown) return Promise.reject(admissionError());
    if (activeReset) return activeReset.ready;

    admissionEpoch += 1;
    const handle = { epoch: admissionEpoch, reason, released: 0 };
    const reset = { handle, ready: null };
    activeReset = reset;
    lineageCache.clear();
    lineageFetches.clear();
    for (const controller of lineageControllers) {
      try {
        controller.abort(admissionError());
      } catch {
      }
    }
    reset.ready = (async () => {
      const pending = [...activeAcquisitions];
      if (pending.length > 0) await Promise.allSettled(pending);
      handle.released = await releaseAll(reason);
      return handle;
    })();
    return reset.ready;
  };

  const resumeAfterReset = async (handle) => {
    const reset = activeReset;
    if (!reset || reset.handle !== handle) return false;
    await reset.ready;
    if (activeReset !== reset) return false;
    activeReset = null;
    return true;
  };

  const releaseAll = async (reason = 'runtime_reset') => {
    const records = [...leasesByID.values()];
    const results = await Promise.all(records.map((record) => releaseRecord(record, reason)));
    return results.filter(Boolean).length;
  };

  const closeAll = async (reason = 'shutdown') => {
    shuttingDown = true;
    return await releaseAll(reason);
  };

  const authorize = (req, res) => {
    setPrivateResponseHeaders(res);
    if (!isLoopbackSocketAddress(req.socket?.remoteAddress)) {
      res.status(404).json({ error: { code: 'unavailable', message: 'Unavailable' } });
      return false;
    }
    const expectedToken = typeof getDiscoveryToken === 'function' ? getDiscoveryToken() : '';
    if (!expectedToken) {
      res.status(404).json({ error: { code: 'unavailable', message: 'Unavailable' } });
      return false;
    }
    if (!isMatchingDiscoveryToken(expectedToken, readBearerToken(req.headers?.authorization))) {
      res.status(401).json({ error: { code: 'unauthorized', message: 'Unauthorized' } });
      return false;
    }
    return true;
  };

  const handleError = (res, error) => {
    const known = error instanceof BrowserLeaseError;
    res.status(known ? error.statusCode : 500).json({
      error: {
        code: known ? error.code : 'internal_error',
        message: known ? error.message : 'Browser lease request failed',
      },
    });
  };

  const handleAcquireRequest = async (req, res) => {
    if (!authorize(req, res)) return;
    try {
      res.status(200).json(await acquire(req.body));
    } catch (error) {
      handleError(res, error);
    }
  };

  const handleTouchRequest = async (req, res) => {
    if (!authorize(req, res)) return;
    try {
      res.status(200).json(await touch(req.params?.leaseId, req.body));
    } catch (error) {
      handleError(res, error);
    }
  };

  const handleReleaseRequest = async (req, res) => {
    if (!authorize(req, res)) return;
    try {
      res.status(200).json(await release(req.params?.leaseId, req.body));
    } catch (error) {
      handleError(res, error);
    }
  };

  const attach = (app) => {
    app.post(BROWSER_LEASES_PATH, handleAcquireRequest);
    app.post(`${BROWSER_LEASES_PATH}/:leaseId/touch`, handleTouchRequest);
    app.delete(`${BROWSER_LEASES_PATH}/:leaseId`, handleReleaseRequest);
  };

  return {
    attach,
    acquire,
    touch,
    release,
    pauseForReset,
    resumeAfterReset,
    releaseAll,
    closeAll,
    processOpenCodeEvent,
    releaseByOpenCodeSession,
    resolveRootSessionID,
    handleHostClosed,
    handleAcquireRequest,
    handleTouchRequest,
    handleReleaseRequest,
    getSnapshot: () => [...leasesByID.values()].map((record) => ({
      leaseId: record.leaseId,
      generation: record.generation,
      ...record.metadata,
      createdAt: record.createdAt,
      lastActivityAt: record.lastActivityAt,
    })),
  };
};
