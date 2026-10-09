import express from 'express';
import { beginSessionCreationTrace, creationRestartPayload, isSessionCreateRequest } from './session-creation.js';
import { registerScopedSessionRevertRoute } from './session-scoped-revert.js';
import { resolveOpenCodeGeneration } from './opencode-generation.js';
import { createOpenCodeV2FacadeRouter, resolveFacadeClient, sendOpenCodeFacadeError } from './v2/facade-routes.js';
import { createOpenCodeV2SseHandler } from './v2/sse-routes.js';

const PROMPT_ASYNC_MESSAGE_ID_HEADER = 'x-openchamber-message-id';

export const registerOpenCodeProxy = (app, deps) => {
  const { OPEN_CODE_READY_GRACE_MS, getRuntime, getOpenCodeAuthHeaders, buildOpenCodeUrl, turnTimingRuntime } = deps;
  if (app.get('opencodeProxyConfigured')) return;
  app.set('opencodeProxyConfigured', true);

  const facade = createOpenCodeV2FacadeRouter(deps);
  const projectedSse = createOpenCodeV2SseHandler({
    globalMessageStreamHub: deps.globalMessageStreamHub,
    resolveRequestDirectory: deps.resolveRequestDirectory,
    eventFilter: deps.messageStreamEventFilter,
    registerConnection: deps.registerMessageStreamConnection,
  });

  app.use('/api', (_req, res, next) => {
    try {
      resolveOpenCodeGeneration(resolveFacadeClient(deps.openCodeClient));
      next();
    } catch (error) { sendOpenCodeFacadeError(res, error); }
  });

  const normalizeString = (value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : '');

  const getSingleHeader = (value) => {
    if (Array.isArray(value)) return normalizeString(value[0]);
    return normalizeString(value);
  };

  const recordPromptAsyncTiming = (req, res, next) => {
    if (req.method !== 'POST' || !turnTimingRuntime) {
      next();
      return;
    }

    const sessionId = normalizeString(req.params?.sessionID);
    if (!sessionId) {
      next();
      return;
    }

    const messageId = getSingleHeader(req.headers?.[PROMPT_ASYNC_MESSAGE_ID_HEADER]);
    const directory = typeof req.query?.directory === 'string' ? req.query.directory : undefined;
    let body = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)
      ? req.body
      : {};
    if (Buffer.isBuffer(req.body) || typeof req.body === 'string') {
      try {
        const parsed = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.body);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          body = parsed;
        }
      } catch {
        // Timing metadata is optional; validation remains in the native facade.
      }
    }
    const model = body.model && typeof body.model === 'object' && !Array.isArray(body.model)
      ? body.model
      : {};
    const metadata = {
      source: 'proxy',
      providerID: normalizeString(model.providerID) || null,
      modelID: normalizeString(model.modelID) || null,
      agent: normalizeString(body.agent) || null,
      variant: normalizeString(body.variant) || null,
    };

    turnTimingRuntime.recordClientMark({
      sessionId,
      messageId,
      mark: 'send_started',
      directory,
      metadata,
    });

    res.once('finish', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      turnTimingRuntime.recordClientMark({
        sessionId,
        messageId,
        mark: 'prompt_accepted',
        directory,
        metadata: {
          ...metadata,
          statusCode: res.statusCode,
        },
      });
    });

    next();
  };

  // Latency attribution for the send path (same pattern as the [questions]
  // slow-request logger): registered ahead of the readiness-hold gate so holdMs
  // is captured even when a request 503s out of the hold.
  const SEND_SLOW_REQUEST_THRESHOLD_MS = 1000;
  app.use('/api/session', (req, res, next) => {
    if (req.method !== 'POST') return next();
    const isCreate = req.path === '/' || req.path === '';
    const isPrompt = req.path.endsWith('/prompt_async');
    if (!isCreate && !isPrompt) return next();
    const tag = isCreate ? '[session]' : '[prompt]';
    const start = Date.now();
    res.on('close', () => {
      const totalMs = Date.now() - start;
      if (totalMs < SEND_SLOW_REQUEST_THRESHOLD_MS) return;
      console.warn(`${tag} slow request`, {
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        totalMs,
        holdMs: req.readinessHoldMs ?? 0,
        proxyMs: req.proxyStartMs ? Date.now() - req.proxyStartMs : null,
      });
    });
    next();
  });

  // Readiness gate — while OpenCode is starting/restarting, HOLD the request and
  // poll readiness instead of returning 503 immediately. A bare 503 pushes the
  // client into an exponential-backoff retry loop (500ms → 1s → …) that wastes
  // seconds of cold-start time and can fail bootstrap outright. Holding the
  // request until OpenCode is ready (typically well under a second) lets the
  // first call simply succeed. We still 503 if readiness doesn't arrive within a
  // bounded window so genuinely-down servers fail fast.
  const READINESS_HOLD_POLL_MS = 75;
  const READINESS_HOLD_MAX_MS = 6000;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const isStillWaiting = (runtimeState) => {
    const waitElapsed = runtimeState.openCodeNotReadySince === 0 ? 0 : Date.now() - runtimeState.openCodeNotReadySince;
    return (
      (!runtimeState.isOpenCodeReady && (runtimeState.openCodeNotReadySince === 0 || waitElapsed < OPEN_CODE_READY_GRACE_MS)) ||
      runtimeState.isRestartingOpenCode ||
      !runtimeState.openCodePort
    );
  };

  app.use('/api', async (req, res, next) => {
    if (
      req.path.startsWith('/themes/custom') ||
      req.path.startsWith('/push') ||
      req.path.startsWith('/config/agent-overrides') ||
      req.path.startsWith('/config/agents') ||
      req.path.startsWith('/config/opencode-resolution') ||
      req.path === '/config/opencode-update-check' ||
      req.path.startsWith('/config/settings') ||
      req.path.startsWith('/config/skills') ||
      req.path === '/config/reload' ||
      req.path === '/config/legacy-cursor-plugin/retire' ||
      req.path === '/health'
    ) {
      return next();
    }

    if (!isStillWaiting(getRuntime())) {
      return next();
    }

    const holdStart = Date.now();
    console.warn('[proxy] readiness hold engaged:', req.method, req.originalUrl);
    const creationTrace = isSessionCreateRequest(req) ? beginSessionCreationTrace(req) : null;
    const deadline = holdStart + Math.min(OPEN_CODE_READY_GRACE_MS, READINESS_HOLD_MAX_MS, creationTrace?.remainingMs() ?? Infinity);
    while (Date.now() < deadline) {
      // Client gave up (closed/aborted) — stop holding.
      if (res.writableEnded || req.aborted) return;
      await sleep(Math.min(READINESS_HOLD_POLL_MS, Math.max(0, deadline - Date.now())));
      if (!isStillWaiting(getRuntime())) {
        req.readinessHoldMs = Date.now() - holdStart;
        console.warn(`[proxy] readiness hold released after ${req.readinessHoldMs}ms:`, req.method, req.originalUrl);
        return next();
      }
    }

    req.readinessHoldMs = Date.now() - holdStart;
    console.warn(`[proxy] readiness hold expired after ${req.readinessHoldMs}ms:`, req.method, req.originalUrl);
    if (!res.headersSent) {
      res.status(503).json(isSessionCreateRequest(req) ? creationRestartPayload() : {
        error: 'OpenCode is restarting',
        restarting: true,
      });
    }
  });

  app.get('/api/global/event', projectedSse);
  app.get('/api/event', projectedSse);

  // Registers scoped-revert, scoped-unrevert (redo) and the change summary
  // ahead of the native facade.
  registerScopedSessionRevertRoute(app, {
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    openCodeSnapshotRoot: deps.openCodeSnapshotRoot,
    openchamberDataDir: deps.openchamberDataDir,
    scopedRevertTimeoutMs: deps.scopedRevertTimeoutMs,
    scopedRevertSlowOperationMs: deps.scopedRevertSlowOperationMs,
    sessionRevertCoordinator: deps.sessionRevertCoordinator,
    assertLegacyRevertAllowed: deps.assertLegacyRevertAllowed,
    recordDiagnostic: deps.recordDiagnostic,
    openCodeClient: deps.openCodeClient,
  });

  app.use(
    '/api/session/:sessionID/prompt_async',
    express.json({ limit: '50mb' }),
    recordPromptAsyncTiming,
  );
  // The native facade terminates unknown and denied routes locally.
  app.use('/api', facade);
};
