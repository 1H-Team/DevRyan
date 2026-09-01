import crypto from 'node:crypto';

const VIEW_ATTACH_TTL_MS = 20_000;
const ACCESS_REVALIDATE_MS = 30_000;
const MAX_ID_LENGTH = 220;
const MAX_LABEL_LENGTH = 1_024;
const STREAM_CONTENT_TYPE_PATTERN = /^multipart\/x-mixed-replace\s*;\s*boundary=/i;

export const BROWSER_AGENT_LEASES_PATH = '/api/browser/agent-leases';

export class BrowserObservationError extends Error {
  constructor(code, message, statusCode = 500) {
    super(message);
    this.name = 'BrowserObservationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const normalizedString = (value, maximum = MAX_LABEL_LENGTH) => (
  typeof value === 'string' ? value.trim().slice(0, maximum) : ''
);

const safeHostname = (...values) => {
  for (const value of values) {
    const raw = normalizedString(value, 8_192);
    if (!raw) continue;
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.hostname.slice(0, MAX_LABEL_LENGTH);
      }
    } catch {
      if (/^[a-z0-9.-]+$/i.test(raw)) return raw.slice(0, MAX_LABEL_LENGTH);
    }
  }
  return '';
};

const publicLease = (record, hostMetadata = null) => ({
  leaseId: normalizedString(record?.leaseId, MAX_ID_LENGTH),
  rootSessionId: normalizedString(record?.rootSessionId, MAX_ID_LENGTH),
  agent: normalizedString(hostMetadata?.agent ?? record?.agent, 256) || 'Agent',
  title: normalizedString(hostMetadata?.title ?? record?.title),
  hostname: safeHostname(
    hostMetadata?.hostname,
    hostMetadata?.url,
    record?.hostname,
    record?.previewUrl,
    record?.previewOrigin,
  ),
  lastActivityAt: Number.isFinite(hostMetadata?.lastActivityAt)
    ? hostMetadata.lastActivityAt
    : Number.isFinite(record?.lastActivityAt)
      ? record.lastActivityAt
      : 0,
  clientAttached: hostMetadata?.clientAttached === true,
});

const isManagedBrowserPrincipal = (principal) => (
  principal?.scope === 'managed'
  && typeof principal.id === 'string'
  && principal.id.length > 0
  && principal.policy?.browser === true
);

const waitForDrain = (response) => new Promise((resolve) => {
  const cleanup = () => {
    response.off?.('drain', onDrain);
    response.off?.('close', onClose);
  };
  const onDrain = () => {
    cleanup();
    resolve(true);
  };
  const onClose = () => {
    cleanup();
    resolve(false);
  };
  response.once('drain', onDrain);
  response.once('close', onClose);
});

export const createBrowserObservationRuntime = ({
  getLeaseRecords,
  ownsSession,
  getHostLeaseMetadata,
  openHostLeaseStream,
  onPrincipalChanged = () => {},
  audit = async () => {},
  now = Date.now,
  randomBytes = crypto.randomBytes,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  viewAttachTtlMs = VIEW_ATTACH_TTL_MS,
  accessRevalidateMs = ACCESS_REVALIDATE_MS,
} = {}) => {
  if (
    typeof getLeaseRecords !== 'function'
    || typeof ownsSession !== 'function'
    || typeof onPrincipalChanged !== 'function'
    || typeof audit !== 'function'
    || typeof now !== 'function'
    || typeof randomBytes !== 'function'
  ) {
    throw new TypeError('Browser observation runtime is misconfigured');
  }

  const views = new Map();
  let revision = 0;

  const records = () => {
    const value = getLeaseRecords();
    return Array.isArray(value) ? value : [];
  };

  const recordForLease = (leaseId) => records().find((record) => record?.leaseId === leaseId) ?? null;

  const assertPrincipal = (principal) => {
    if (!isManagedBrowserPrincipal(principal)) {
      throw new BrowserObservationError(
        'browser_observation_forbidden',
        'Agent browser observation is unavailable for this account',
        403,
      );
    }
  };

  const canAccessRecord = async (principal, record) => {
    if (!isManagedBrowserPrincipal(principal) || !record) return false;
    if (normalizedString(record.ownerUserId, MAX_ID_LENGTH) !== principal.id) return false;
    const rootSessionId = normalizedString(record.rootSessionId, MAX_ID_LENGTH);
    return Boolean(rootSessionId && await ownsSession(principal, rootSessionId));
  };

  const requireRecord = async (principal, leaseIdInput) => {
    assertPrincipal(principal);
    const leaseId = normalizedString(leaseIdInput, MAX_ID_LENGTH);
    const record = leaseId ? recordForLease(leaseId) : null;
    if (!record || !await canAccessRecord(principal, record)) {
      throw new BrowserObservationError(
        'browser_lease_not_found',
        'Agent browser lease was not found',
        404,
      );
    }
    return record;
  };

  const deleteView = (view, reason = 'stopped') => {
    if (!view || views.get(view.id) !== view) return false;
    views.delete(view.id);
    if (view.expiryTimer) clearTimer(view.expiryTimer);
    view.expiryTimer = null;
    try {
      view.controller.abort(new Error(reason));
    } catch {
    }
    return true;
  };

  const auditViewStop = async (principal, view, reason) => {
    if (view.stopAudited) return;
    view.stopAudited = true;
    await audit(principal, 'browser.agent_view.stop', {
      targetType: 'session',
      targetId: view.rootSessionId,
      sessionId: view.rootSessionId,
      metadata: { leaseId: view.leaseId, reason },
    });
  };

  const list = async (principal) => {
    assertPrincipal(principal);
    const owned = [];
    for (const record of records()) {
      if (await canAccessRecord(principal, record)) owned.push(record);
    }

    let hostById = new Map();
    if (owned.length > 0 && typeof getHostLeaseMetadata === 'function') {
      try {
        const hostSnapshot = await getHostLeaseMetadata({
          leaseIds: owned.map((record) => record.leaseId),
        });
        const entries = Array.isArray(hostSnapshot?.leases) ? hostSnapshot.leases : [];
        hostById = new Map(entries.flatMap((entry) => {
          const leaseId = normalizedString(entry?.leaseId, MAX_ID_LENGTH);
          return leaseId ? [[leaseId, entry]] : [];
        }));
      } catch {
        // The authoritative server records still provide a safe, useful list.
      }
    }

    const leases = owned
      .map((record) => publicLease(record, hostById.get(record.leaseId)))
      .filter((lease) => lease.leaseId && lease.rootSessionId)
      .sort((left, right) => right.lastActivityAt - left.lastActivityAt);
    return Object.freeze({ revision, leases });
  };

  const startView = async (principal, leaseIdInput) => {
    const record = await requireRecord(principal, leaseIdInput);
    if (typeof openHostLeaseStream !== 'function') {
      throw new BrowserObservationError(
        'browser_observation_unavailable',
        'Live agent browser viewing is unavailable',
        503,
      );
    }
    for (const existing of views.values()) {
      if (existing.principalId === principal.id && existing.leaseId === record.leaseId) {
        deleteView(existing, 'replaced');
        await auditViewStop(principal, existing, 'replaced');
      }
    }

    let id;
    do {
      id = `agent_view_${Buffer.from(randomBytes(18)).toString('base64url')}`;
    } while (views.has(id));
    const createdAt = now();
    const view = {
      id,
      leaseId: record.leaseId,
      rootSessionId: record.rootSessionId,
      principalId: principal.id,
      createdAt,
      attachExpiresAt: createdAt + viewAttachTtlMs,
      attached: false,
      controller: new AbortController(),
      expiryTimer: null,
      stopAudited: false,
    };
    view.expiryTimer = setTimer(() => {
      if (deleteView(view, 'attach_expired')) {
        void auditViewStop(principal, view, 'attach_expired').catch(() => undefined);
      }
    }, viewAttachTtlMs);
    view.expiryTimer.unref?.();
    views.set(id, view);
    try {
      await audit(principal, 'browser.agent_view.start', {
        targetType: 'session',
        targetId: record.rootSessionId,
        sessionId: record.rootSessionId,
        metadata: { leaseId: record.leaseId },
      });
    } catch (error) {
      deleteView(view, 'audit_failed');
      throw error;
    }
    return Object.freeze({
      view: Object.freeze({
        id,
        leaseId: record.leaseId,
        startedAt: new Date(createdAt).toISOString(),
        streamUrl: `${BROWSER_AGENT_LEASES_PATH}/${encodeURIComponent(record.leaseId)}/views/${encodeURIComponent(id)}/stream`,
      }),
    });
  };

  const stopView = async (principal, leaseIdInput, viewIdInput, reason = 'stopped') => {
    assertPrincipal(principal);
    const leaseId = normalizedString(leaseIdInput, MAX_ID_LENGTH);
    const viewId = normalizedString(viewIdInput, MAX_ID_LENGTH);
    const view = views.get(viewId);
    if (!view) return Object.freeze({ stopped: false });
    if (view.leaseId !== leaseId || view.principalId !== principal.id) {
      throw new BrowserObservationError('browser_view_not_found', 'Browser viewer session was not found', 404);
    }
    deleteView(view, reason);
    await auditViewStop(principal, view, reason);
    return Object.freeze({ stopped: true });
  };

  const openView = async (principal, leaseIdInput, viewIdInput, response) => {
    assertPrincipal(principal);
    const leaseId = normalizedString(leaseIdInput, MAX_ID_LENGTH);
    const viewId = normalizedString(viewIdInput, MAX_ID_LENGTH);
    const view = views.get(viewId);
    if (
      !view
      || view.leaseId !== leaseId
      || view.principalId !== principal.id
      || view.attached
    ) {
      throw new BrowserObservationError('browser_view_not_found', 'Browser viewer session was not found', 404);
    }
    if (view.attachExpiresAt <= now()) {
      deleteView(view, 'attach_expired');
      throw new BrowserObservationError('browser_view_expired', 'Browser viewer session expired', 410);
    }
    const record = await requireRecord(principal, leaseId);
    view.attached = true;
    if (view.expiryTimer) clearTimer(view.expiryTimer);
    view.expiryTimer = null;

    let hostStream;
    try {
      hostStream = await openHostLeaseStream({ leaseId, signal: view.controller.signal });
    } catch {
      deleteView(view, 'host_unavailable');
      throw new BrowserObservationError(
        'browser_observation_unavailable',
        'Live agent browser viewing is unavailable',
        503,
      );
    }
    const contentType = normalizedString(hostStream?.contentType, 512);
    if (!STREAM_CONTENT_TYPE_PATTERN.test(contentType) || !hostStream?.body) {
      deleteView(view, 'invalid_host_stream');
      throw new BrowserObservationError(
        'browser_observation_unavailable',
        'Live agent browser viewing is unavailable',
        503,
      );
    }

    response.status(200);
    response.setHeader('Content-Type', contentType);
    response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, no-transform');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders?.();

    const revalidate = setIntervalFn(() => {
      void (async () => {
        const current = recordForLease(leaseId);
        if (!current || !await canAccessRecord(principal, current)) {
          deleteView(view, 'access_revoked');
        }
      })().catch(() => deleteView(view, 'access_check_failed'));
    }, accessRevalidateMs);
    revalidate.unref?.();

    try {
      for await (const chunk of hostStream.body) {
        if (view.controller.signal.aborted || response.destroyed) break;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (bytes.byteLength === 0) continue;
        if (!response.write(bytes) && !await waitForDrain(response)) break;
      }
    } finally {
      clearIntervalFn(revalidate);
      deleteView(view, 'stream_closed');
      if (!response.destroyed && !response.writableEnded) response.end();
      await auditViewStop(principal, view, 'stream_closed').catch(() => undefined);
    }
  };

  const handleLeaseChanged = ({ leaseId, ownerUserId } = {}) => {
    revision += 1;
    const normalizedLeaseId = normalizedString(leaseId, MAX_ID_LENGTH);
    if (normalizedLeaseId && !recordForLease(normalizedLeaseId)) {
      for (const view of views.values()) {
        if (view.leaseId === normalizedLeaseId) deleteView(view, 'lease_closed');
      }
    }
    const principalId = normalizedString(ownerUserId, MAX_ID_LENGTH);
    if (principalId) onPrincipalChanged(principalId, revision);
    return revision;
  };

  const handleError = (response, error) => {
    const known = error instanceof BrowserObservationError;
    response.status(known ? error.statusCode : 500).json({
      error: known ? error.message : 'Browser observation request failed',
      code: known ? error.code : 'browser_observation_failed',
    });
  };

  const registerRoutes = (app) => {
    app.get(BROWSER_AGENT_LEASES_PATH, async (request, response) => {
      try {
        response.setHeader('Cache-Control', 'no-store');
        response.json(await list(request.principal));
      } catch (error) {
        handleError(response, error);
      }
    });
    app.post(`${BROWSER_AGENT_LEASES_PATH}/:leaseId/views`, async (request, response) => {
      try {
        response.status(201).json(await startView(request.principal, request.params?.leaseId));
      } catch (error) {
        handleError(response, error);
      }
    });
    app.get(`${BROWSER_AGENT_LEASES_PATH}/:leaseId/views/:viewId/stream`, async (request, response) => {
      try {
        await openView(request.principal, request.params?.leaseId, request.params?.viewId, response);
      } catch (error) {
        if (!response.headersSent) handleError(response, error);
        else if (!response.destroyed) response.destroy(error);
      }
    });
    app.delete(`${BROWSER_AGENT_LEASES_PATH}/:leaseId/views/:viewId`, async (request, response) => {
      try {
        response.json(await stopView(
          request.principal,
          request.params?.leaseId,
          request.params?.viewId,
          'client_stopped',
        ));
      } catch (error) {
        handleError(response, error);
      }
    });
  };

  const closeAll = () => {
    for (const view of views.values()) deleteView(view, 'runtime_closed');
  };

  return {
    registerRoutes,
    list,
    startView,
    openView,
    stopView,
    handleLeaseChanged,
    closeAll,
    getRevision: () => revision,
    getViewCount: () => views.size,
  };
};
