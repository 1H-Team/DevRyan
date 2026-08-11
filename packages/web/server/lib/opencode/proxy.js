import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';

import {
  applyForwardProxyResponseHeaders,
  collectForwardProxyHeaders,
  shouldForwardProxyResponseHeader,
} from '../../proxy-headers.js';
import { registerScopedSessionRevertRoute } from './session-scoped-revert.js';
import { createHarnessError, withHarnessResult } from './harness-result.js';
import { stripMessageDiffContent } from './diff-summary.js';

const PROMPT_ASYNC_MESSAGE_ID_HEADER = 'x-openchamber-message-id';
// Transcripts carry diff snapshots and are not a fast control-plane read.
const SESSION_MESSAGE_FETCH_TIMEOUT_MS = 120_000;

export const waitForSseDrain = (res, signal) => new Promise((resolve) => {
  if (signal?.aborted || res.writableEnded || res.destroyed) {
    resolve();
    return;
  }

  const cleanup = () => {
    res.off?.('drain', onDone);
    res.off?.('close', onDone);
    res.off?.('error', onDone);
    signal?.removeEventListener?.('abort', onDone);
  };
  const onDone = () => {
    cleanup();
    resolve();
  };

  res.once?.('drain', onDone);
  res.once?.('close', onDone);
  res.once?.('error', onDone);
  signal?.addEventListener?.('abort', onDone, { once: true });
});

export const writeSseChunkWithBackpressure = async (res, value, signal) => {
  if (!value || value.length === 0 || signal?.aborted || res.writableEnded || res.destroyed) {
    return false;
  }

  const flushed = res.write(value);
  if (flushed !== false) {
    return true;
  }

  await waitForSseDrain(res, signal);
  return !signal?.aborted && !res.writableEnded && !res.destroyed;
};

export const createSseBoundaryTracker = () => {
  const decoder = new TextDecoder();
  let tail = '';

  const normalize = (value) => value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  return {
    observe(value) {
      const text = typeof value === 'string'
        ? value
        : decoder.decode(value, { stream: true });
      if (text.length > 0) {
        tail = `${tail}${normalize(text)}`;
        if (tail.length > 4096) {
          tail = tail.slice(-4096);
        }
      }
      return this.isAtBoundary();
    },
    isAtBoundary() {
      return tail.length === 0 || tail.endsWith('\n\n');
    },
  };
};

const hasForwardableRequestBody = (req) => {
  const contentLength = Number(req.headers?.['content-length'] ?? 0);
  return contentLength > 0 || Boolean(req.headers?.['transfer-encoding']);
};

export const replayParsedRequestBody = (proxyReq, req) => {
  if (!hasForwardableRequestBody(req) || req.body === undefined) {
    return;
  }

  const contentType = String(req.headers?.['content-type'] ?? '').toLowerCase();
  if (!contentType.includes('application/json')) {
    return;
  }

  // Prefer the raw bytes captured by express.json's verify hook: no middleware
  // reassigns req.body, so they are still the exact client payload and reusing
  // them skips a full re-serialization of possibly multi-MB prompt bodies.
  const body = Buffer.isBuffer(req.body)
    ? req.body
    : (req.rawBody instanceof Buffer ? req.rawBody : Buffer.from(JSON.stringify(req.body)));
  proxyReq.setHeader('content-length', String(body.byteLength));
  proxyReq.write(body);
};

export const registerOpenCodeProxy = (app, deps) => {
  const {
    fs,
    os,
    path,
    OPEN_CODE_READY_GRACE_MS,
    getRuntime,
    getOpenCodeAuthHeaders,
    buildOpenCodeUrl,
    ensureOpenCodeApiPrefix,
    turnTimingRuntime,
  } = deps;

  if (app.get('opencodeProxyConfigured')) {
    return;
  }

  const runtime = getRuntime();
  if (runtime.openCodePort) {
    console.log(`Setting up proxy to OpenCode on port ${runtime.openCodePort}`);
  } else {
    console.log('Setting up OpenCode API gate (OpenCode not started yet)');
  }
  app.set('opencodeProxyConfigured', true);

  const isAbortError = (error) => error?.name === 'AbortError';
  const FALLBACK_PROXY_TARGET = 'http://127.0.0.1:3902';

  const normalizeProxyTarget = (candidate) => {
    if (typeof candidate !== 'string') {
      return null;
    }

    const trimmed = candidate.trim();
    if (!trimmed) {
      return null;
    }

    return trimmed.replace(/\/+$/, '');
  };

  // Keep generic proxy requests on the same upstream base URL that health checks
  // and direct fetch helpers use. This avoids split-brain state where /health
  // succeeds against an external host but /api/* still proxies to 127.0.0.1.
  const resolveProxyTarget = () => {
    try {
      const resolved = normalizeProxyTarget(buildOpenCodeUrl('/', ''));
      if (resolved) {
        return resolved;
      }
    } catch {
    }

    const runtimeState = getRuntime();
    const externalBase = normalizeProxyTarget(runtimeState.openCodeBaseUrl);
    if (externalBase) {
      return externalBase;
    }

    if (runtimeState.openCodePort) {
      return `http://localhost:${runtimeState.openCodePort}`;
    }

    return FALLBACK_PROXY_TARGET;
  };

  const forwardSseRequest = async (req, res) => {
    const abortController = new AbortController();
    const closeUpstream = () => abortController.abort();
    let upstream = null;
    let reader = null;
    let heartbeatTimer = null;
    let writeQueue = Promise.resolve(true);
    const sseBoundary = createSseBoundaryTracker();

    req.on('close', closeUpstream);

    try {
      const requestUrl = typeof req.originalUrl === 'string' && req.originalUrl.length > 0
        ? req.originalUrl
        : (typeof req.url === 'string' ? req.url : '');
      const upstreamPath = requestUrl.startsWith('/api') ? requestUrl.slice(4) || '/' : requestUrl;
      const headers = collectForwardProxyHeaders(req.headers, getOpenCodeAuthHeaders());
      headers.accept ??= 'text/event-stream';
      headers['cache-control'] ??= 'no-cache';

      upstream = await fetch(buildOpenCodeUrl(upstreamPath, ''), {
        method: 'GET',
        headers,
        signal: abortController.signal,
      });

      res.status(upstream.status);
      applyForwardProxyResponseHeaders(upstream.headers, res);

      const contentType = upstream.headers.get('content-type') || 'text/event-stream';
      const isEventStream = contentType.toLowerCase().includes('text/event-stream');

      if (!upstream.body) {
        res.end(await upstream.text().catch(() => ''));
        return;
      }

      if (!isEventStream) {
        res.end(await upstream.text());
        return;
      }

      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
      }

      // Disable TCP Nagle's algorithm so small SSE chunks are sent immediately
      // instead of being buffered up to ~200ms by the TCP stack.
      if (res.socket && typeof res.socket.setNoDelay === 'function') {
        res.socket.setNoDelay(true);
      }

      const SSE_HEARTBEAT_INTERVAL_MS = 20_000;

      const scheduleHeartbeat = () => {
        heartbeatTimer = setTimeout(async () => {
          if (abortController.signal.aborted || res.writableEnded || res.destroyed) {
            return;
          }
          if (!sseBoundary.isAtBoundary()) {
            scheduleHeartbeat();
            return;
          }
          const canContinue = await enqueueSseWrite(':heartbeat\n\n');
          if (canContinue) {
            scheduleHeartbeat();
          }
        }, SSE_HEARTBEAT_INTERVAL_MS);
      };

      const enqueueSseWrite = (value) => {
        writeQueue = writeQueue
          .catch(() => false)
          .then((canContinue) => {
            if (!canContinue) {
              return false;
            }
            return writeSseChunkWithBackpressure(res, value, abortController.signal);
          });
        return writeQueue;
      };

      scheduleHeartbeat();

      reader = upstream.body.getReader();
      while (!abortController.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value && value.length > 0) {
          sseBoundary.observe(value);
          const canContinue = await enqueueSseWrite(value);
          if (!canContinue) {
            break;
          }
        }
      }

      res.end();
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }
      console.error('[proxy] OpenCode SSE proxy error:', error?.message ?? error);
      if (!res.headersSent) {
        res.status(503).json({ error: 'OpenCode service unavailable' });
      } else {
        res.end();
      }
    } finally {
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }
      req.off('close', closeUpstream);
      try {
        if (reader) {
          await reader.cancel();
          reader.releaseLock();
        } else if (upstream?.body && !upstream.body.locked) {
          await upstream.body.cancel();
        }
      } catch {
      }
    }
  };

  const formatMcpAction = (action) => (action === 'disconnect' ? 'disconnecting' : 'connecting');

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
        // Timing metadata is optional; leave an unparseable proxied body untouched.
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

  const forwardMcpActionRequest = async (req, res, next) => {
    const action = typeof req.params?.action === 'string' ? req.params.action : '';
    if (action !== 'connect' && action !== 'disconnect') {
      return next();
    }

    const serverName = typeof req.params?.name === 'string' ? req.params.name : '';
    const requestUrl = typeof req.originalUrl === 'string' && req.originalUrl.length > 0
      ? req.originalUrl
      : (typeof req.url === 'string' ? req.url : '');
    const upstreamPath = requestUrl.startsWith('/api') ? requestUrl.slice(4) || '/' : requestUrl;
    const headers = collectForwardProxyHeaders(req.headers, getOpenCodeAuthHeaders());
    headers['accept-encoding'] = 'identity';

    const fetchOptions = {
      method: 'POST',
      headers,
    };

    if (hasForwardableRequestBody(req)) {
      // MCP connect/disconnect is currently bodyless, but forwarding a present body
      // keeps this route compatible if OpenCode adds action options later.
      fetchOptions.body = req;
      fetchOptions.duplex = 'half';
    }

    try {
      const upstream = await fetch(buildOpenCodeUrl(upstreamPath, ''), fetchOptions);
      const body = await upstream.text();

      if (!upstream.ok && body.length === 0) {
        return res.status(upstream.status).json(withHarnessResult({
          error: `MCP server ${action} failed`,
          server: serverName,
          status: upstream.status,
        }, createHarnessError({
          summary: `MCP server "${serverName || 'unknown'}" ${action} failed`,
          nextActions: ['Check the MCP server status and retry the connection action'],
          artifacts: [serverName].filter(Boolean),
          recovery: {
            rootCauseHint: `OpenCode returned ${upstream.status} with no diagnostic body`,
            safeRetry: `Retry MCP ${action} after refreshing status`,
            stopCondition: 'Stop if OpenCode keeps returning an empty failure for this MCP server',
            retryable: true,
          },
        })));
      }

      res.status(upstream.status);
      applyForwardProxyResponseHeaders(upstream.headers, res);
      return res.send(body);
    } catch (error) {
      console.error(`[proxy] OpenCode MCP ${action} proxy error for ${serverName || 'unknown'}:`, error?.message ?? error);
      return res.status(503).json(withHarnessResult({
        error: `OpenCode service unavailable while ${formatMcpAction(action)} MCP server`,
        server: serverName,
      }, createHarnessError({
        summary: `MCP server "${serverName || 'unknown'}" ${action} unavailable`,
        nextActions: ['Wait for OpenCode to become available, then retry the MCP action'],
        artifacts: [serverName].filter(Boolean),
        recovery: {
          rootCauseHint: error?.message || 'OpenCode service was unavailable',
          safeRetry: `Retry MCP ${action} after OpenCode readiness recovers`,
          stopCondition: 'Stop if OpenCode remains unavailable after restart',
          retryable: true,
        },
      })));
    }
  };

  // Ensure API prefix is detected before proxying
  app.use('/api', (_req, _res, next) => {
    ensureOpenCodeApiPrefix();
    next();
  });

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
      req.path.startsWith('/config/settings') ||
      req.path.startsWith('/config/skills') ||
      req.path === '/config/reload' ||
      req.path === '/health'
    ) {
      return next();
    }

    if (!isStillWaiting(getRuntime())) {
      return next();
    }

    const holdStart = Date.now();
    console.warn('[proxy] readiness hold engaged:', req.method, req.originalUrl);
    const deadline = holdStart + Math.min(OPEN_CODE_READY_GRACE_MS, READINESS_HOLD_MAX_MS);
    while (Date.now() < deadline) {
      // Client gave up (closed/aborted) — stop holding.
      if (res.writableEnded || req.aborted) return;
      await sleep(READINESS_HOLD_POLL_MS);
      if (!isStillWaiting(getRuntime())) {
        req.readinessHoldMs = Date.now() - holdStart;
        console.warn(`[proxy] readiness hold released after ${req.readinessHoldMs}ms:`, req.method, req.originalUrl);
        return next();
      }
    }

    req.readinessHoldMs = Date.now() - holdStart;
    console.warn(`[proxy] readiness hold expired after ${req.readinessHoldMs}ms:`, req.method, req.originalUrl);
    if (!res.headersSent) {
      res.status(503).json({
        error: 'OpenCode is restarting',
        restarting: true,
      });
    }
  });

  // Windows: session merge for cross-directory session listing
  if (process.platform === 'win32') {
    app.get('/api/session', async (req, res, next) => {
      const rawUrl = req.originalUrl || req.url || '';
      if (rawUrl.includes('directory=')) return next();

      try {
        const authHeaders = getOpenCodeAuthHeaders();
        const fetchOpts = {
          method: 'GET',
          headers: { Accept: 'application/json', ...authHeaders },
          signal: AbortSignal.timeout(10000),
        };
        const globalRes = await fetch(buildOpenCodeUrl('/session', ''), fetchOpts);
        const globalPayload = globalRes.ok ? await globalRes.json().catch(() => []) : [];
        const globalSessions = Array.isArray(globalPayload) ? globalPayload : [];

        const settingsPath = path.join(os.homedir(), '.config', 'openchamber', 'settings.json');
        let projectDirs = [];
        try {
          const settingsRaw = fs.readFileSync(settingsPath, 'utf8');
          const settings = JSON.parse(settingsRaw);
          projectDirs = (settings.projects || [])
            .map((project) => (typeof project?.path === 'string' ? project.path.trim() : ''))
            .filter(Boolean);
        } catch {
        }

        const seen = new Set(
          globalSessions
            .map((session) => (session && typeof session.id === 'string' ? session.id : null))
            .filter((id) => typeof id === 'string')
        );
        const extraSessions = [];
        for (const dir of projectDirs) {
          const candidates = Array.from(new Set([
            dir,
            dir.replace(/\\/g, '/'),
            dir.replace(/\//g, '\\'),
          ]));
          for (const candidateDir of candidates) {
            const encoded = encodeURIComponent(candidateDir);
            try {
              const dirRes = await fetch(buildOpenCodeUrl(`/session?directory=${encoded}`, ''), fetchOpts);
              if (dirRes.ok) {
                const dirPayload = await dirRes.json().catch(() => []);
                const dirSessions = Array.isArray(dirPayload) ? dirPayload : [];
                for (const session of dirSessions) {
                  const id = session && typeof session.id === 'string' ? session.id : null;
                  if (id && !seen.has(id)) {
                    seen.add(id);
                    extraSessions.push(session);
                  }
                }
              }
            } catch {
            }
          }
        }

        const merged = [...globalSessions, ...extraSessions];
        merged.sort((a, b) => {
          const aTime = a && typeof a.time_updated === 'number' ? a.time_updated : 0;
          const bTime = b && typeof b.time_updated === 'number' ? b.time_updated : 0;
          return bTime - aTime;
        });
        console.log(`[SessionMerge] ${globalSessions.length} global + ${extraSessions.length} extra = ${merged.length} total`);
        return res.json(merged);
      } catch (error) {
        console.log(`[SessionMerge] Error: ${error.message}, falling through`);
        next();
      }
    });
  }

  app.get('/api/global/event', forwardSseRequest);
  app.get('/api/event', forwardSseRequest);

  registerScopedSessionRevertRoute(app, {
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    openCodeSnapshotRoot: deps.openCodeSnapshotRoot,
    scopedRevertTimeoutMs: deps.scopedRevertTimeoutMs,
    scopedRevertSlowOperationMs: deps.scopedRevertSlowOperationMs,
  });

  app.post('/api/mcp/:name/:action', forwardMcpActionRequest);
  app.use(
    '/api/session/:sessionID/prompt_async',
    express.json({ limit: '50mb', verify: (req, _res, buf) => { req.rawBody = buf; } }),
    recordPromptAsyncTiming,
  );

  // Trim diff-snapshot patch bodies before a transcript reaches the renderer.
  // OpenCode attaches a full git diff snapshot to user messages; on a workspace
  // with a large untracked tree this dwarfs the conversation (~92MB observed for
  // a 21-message session) and the renderer has to receive, parse and retain all
  // of it. The UI only reads the per-entry counts, so the bodies are dropped
  // here and never cross the wire. Registered ahead of the generic /api proxy;
  // any failure falls through to that proxy so behaviour is unchanged on error.
  app.get('/api/session/:sessionID/message', async (req, res, next) => {
    let upstream;
    try {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(req.query ?? {})) {
        if (typeof value === 'string') query.set(key, value);
      }
      const serialized = query.toString();
      upstream = await fetch(
        buildOpenCodeUrl(
          `/session/${encodeURIComponent(req.params.sessionID)}/message${serialized ? `?${serialized}` : ''}`,
          '',
        ),
        {
          headers: {
            accept: 'application/json',
            'accept-encoding': 'identity',
            ...getOpenCodeAuthHeaders(),
          },
          signal: AbortSignal.timeout(SESSION_MESSAGE_FETCH_TIMEOUT_MS),
        },
      );
    } catch {
      next();
      return;
    }

    if (!upstream.ok) {
      next();
      return;
    }

    try {
      const records = await upstream.json();
      if (!Array.isArray(records)) {
        next();
        return;
      }
      // Forward the pagination cursor — clients page older history with it,
      // and res.json alone would silently drop it.
      const nextCursor = upstream.headers?.get?.('x-next-cursor');
      if (nextCursor) res.setHeader('x-next-cursor', nextCursor);
      res.json(records.map(stripMessageDiffContent));
    } catch {
      if (!res.headersSent) next();
    }
  });

  // Generic proxy for non-SSE OpenCode API routes.
  const apiProxy = createProxyMiddleware({
    target: resolveProxyTarget(),
    changeOrigin: true,
    pathRewrite: { '^/api': '' },
    // Dynamic target — port can change after restart
    router: () => resolveProxyTarget(),
    on: {
      proxyReq: (proxyReq, req) => {
        req.proxyStartMs = Date.now();
        // Inject OpenCode auth headers
        const authHeaders = getOpenCodeAuthHeaders();
        if (authHeaders.Authorization) {
          proxyReq.setHeader('Authorization', authHeaders.Authorization);
        }

        // Defensive: request identity encoding from upstream OpenCode.
        // This avoids compressed-body/header mismatches in multi-proxy setups.
        proxyReq.setHeader('accept-encoding', 'identity');
        if (typeof proxyReq.removeHeader === 'function') {
          proxyReq.removeHeader(PROMPT_ASYNC_MESSAGE_ID_HEADER);
        }

        replayParsedRequestBody(proxyReq, req);
      },
      proxyRes: (proxyRes) => {
        for (const key of Object.keys(proxyRes.headers || {})) {
          if (!shouldForwardProxyResponseHeader(key)) {
            delete proxyRes.headers[key];
          }
        }
      },
      error: (err, _req, res) => {
        console.error('[proxy] OpenCode proxy error:', err.message);
        if (res && !res.headersSent && typeof res.status === 'function') {
          res.status(503).json({ error: 'OpenCode service unavailable', retryable: true });
        }
      },
    },
  });

  app.use('/api', apiProxy);
};
