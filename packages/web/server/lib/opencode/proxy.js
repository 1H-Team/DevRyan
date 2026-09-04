import express from 'express';
import { beginSessionCreationTrace, creationUnknownPayload, creationRestartPayload, creationNotDispatchedPayload, isSessionCreateRequest } from './session-creation.js';
import http from 'node:http';
import https from 'node:https';
import { createProxyMiddleware } from 'http-proxy-middleware';

import {
  applyForwardProxyResponseHeaders,
  collectForwardProxyHeaders,
  shouldForwardProxyResponseHeader,
} from '../../proxy-headers.js';
import { ensureOAuthLoopbackPortAvailable } from './oauth-loopback-preflight.js';
import { registerScopedSessionRevertRoute } from './session-scoped-revert.js';
import { createHarnessError, withHarnessResult } from './harness-result.js';
import { stripEventDiffContent, stripMessageDiffContent } from './diff-summary.js';

const PROMPT_ASYNC_MESSAGE_ID_HEADER = 'x-openchamber-message-id';
// Transcripts carry diff snapshots and are not a fast control-plane read.
const SESSION_MESSAGE_FETCH_TIMEOUT_MS = 120_000;

export const OPEN_CODE_PROXY_AGENT_OPTIONS = Object.freeze({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: Infinity,
  maxFreeSockets: 256,
  timeout: 60_000,
});

export const createOpenCodeProxyAgentResolver = (resolveTarget) => {
  let httpAgent = null;
  let httpsAgent = null;

  const resolve = () => {
    const target = resolveTarget();
    if (typeof target === 'string' && target.toLowerCase().startsWith('https://')) {
      httpsAgent ??= new https.Agent(OPEN_CODE_PROXY_AGENT_OPTIONS);
      return httpsAgent;
    }
    httpAgent ??= new http.Agent(OPEN_CODE_PROXY_AGENT_OPTIONS);
    return httpAgent;
  };

  resolve.destroy = () => {
    httpAgent?.destroy();
    httpsAgent?.destroy();
  };
  return resolve;
};

export const defineDynamicProxyAgent = (options, resolveAgent) => {
  Object.defineProperty(options, 'agent', {
    configurable: false,
    enumerable: true,
    get: resolveAgent,
  });
  return options;
};

const normalizeProxyTarget = (candidate) => {
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  return trimmed ? trimmed.replace(/\/+$/, '') : null;
};

export const resolveOpenCodeProxyTarget = ({ getRuntime, buildOpenCodeUrl, fallbackTarget }) => {
  const runtimeState = getRuntime();
  if (runtimeState.openCodePort) {
    const resolved = normalizeProxyTarget(buildOpenCodeUrl('/', ''));
    if (resolved) return resolved;
  }

  return normalizeProxyTarget(runtimeState.openCodeBaseUrl) || fallbackTarget;
};

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

// A single upstream SSE block is never forwarded partially below this size, so
// the stripper can parse it whole. Beyond it the bytes are passed through raw
// (unparsed) rather than buffered, so the stream never stalls on one event.
export const SSE_DIFF_STRIP_MAX_BLOCK_CHARS = 256 * 1024 * 1024;
const SSE_DIFF_STRIP_MARKER = '"diffs"';

const normalizeSseLineEndings = (value) => value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

const stripSseEnvelope = (parsed, strip) => {
  if (parsed && typeof parsed === 'object' && parsed.payload && typeof parsed.payload === 'object') {
    // `/global/event` wraps each event as `{ directory, payload }`.
    const payload = strip(parsed.payload);
    return payload === parsed.payload ? parsed : { ...parsed, payload };
  }
  return strip(parsed);
};

/**
 * Block-level transform for the raw OpenCode SSE byte stream. Complete blocks
 * (terminated by a blank line) are forwarded one at a time; only a block whose
 * data mentions `"diffs"` is parsed, trimmed with `stripEventDiffContent`, and
 * re-serialised with its `id:`/`event:`/comment lines intact. Everything else
 * (heartbeats, comments, unparsable blocks) is forwarded verbatim.
 */
export const createSseDiffStripper = ({
  strip = stripEventDiffContent,
  maxBlockChars = SSE_DIFF_STRIP_MAX_BLOCK_CHARS,
} = {}) => {
  const decoder = new TextDecoder();
  let buffer = '';
  let scanFrom = 0;
  let pendingCarriageReturn = false;
  let passthroughUntilBoundary = false;

  const transformBlock = (block) => {
    if (!block.includes(SSE_DIFF_STRIP_MARKER)) return block;
    const lines = block.split('\n');
    const dataLines = [];
    let firstDataLine = -1;
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].startsWith('data:')) continue;
      if (firstDataLine === -1) firstDataLine = index;
      dataLines.push(lines[index].slice(5).replace(/^\s/, ''));
    }
    if (firstDataLine === -1) return block;

    let parsed;
    try {
      parsed = JSON.parse(dataLines.join('\n'));
    } catch {
      return block;
    }
    let stripped;
    try {
      stripped = stripSseEnvelope(parsed, strip);
    } catch {
      return block;
    }
    if (stripped === parsed) return block;

    const output = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].startsWith('data:')) {
        if (index === firstDataLine) output.push(`data: ${JSON.stringify(stripped)}`);
        continue;
      }
      output.push(lines[index]);
    }
    return output.join('\n');
  };

  return {
    /** Feed one upstream chunk; returns the text that may be forwarded now. */
    push(chunk) {
      let text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      if (pendingCarriageReturn) {
        text = `\r${text}`;
        pendingCarriageReturn = false;
      }
      if (text.endsWith('\r')) {
        // A CR at the chunk edge may be half of a CRLF; hold it for the next chunk.
        pendingCarriageReturn = true;
        text = text.slice(0, -1);
      }
      if (text.length === 0) return '';
      buffer += normalizeSseLineEndings(text);

      let output = '';
      for (;;) {
        const boundary = buffer.indexOf('\n\n', scanFrom);
        if (boundary === -1) break;
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        scanFrom = 0;
        if (passthroughUntilBoundary) {
          passthroughUntilBoundary = false;
          output += `${block}\n\n`;
          continue;
        }
        output += `${transformBlock(block)}\n\n`;
      }
      // Resume the boundary scan one char back so a "\n\n" split across chunks is found.
      scanFrom = buffer.length > 0 ? buffer.length - 1 : 0;
      if (buffer.length > maxBlockChars) {
        output += buffer;
        buffer = '';
        scanFrom = 0;
        passthroughUntilBoundary = true;
      }
      return output;
    },
    /** Stream end: forward whatever partial block remains, unparsed. */
    flush() {
      let text = decoder.decode();
      if (pendingCarriageReturn) {
        text = `\r${text}`;
        pendingCarriageReturn = false;
      }
      const output = `${buffer}${normalizeSseLineEndings(text)}`;
      buffer = '';
      scanFrom = 0;
      passthroughUntilBoundary = false;
      return output;
    },
  };
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
    ensureOAuthLoopbackPortAvailable: ensureOAuthLoopbackPortAvailableDep,
  } = deps;

  const runOAuthLoopbackPreflight = typeof ensureOAuthLoopbackPortAvailableDep === 'function'
    ? ensureOAuthLoopbackPortAvailableDep
    : ensureOAuthLoopbackPortAvailable;

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

  // Keep generic proxy requests on the same upstream base URL that health checks
  // and direct fetch helpers use. This avoids split-brain state where /health
  // succeeds against an external host but /api/* still proxies to 127.0.0.1.
  const resolveProxyTarget = () => resolveOpenCodeProxyTarget({
    getRuntime,
    buildOpenCodeUrl,
    fallbackTarget: FALLBACK_PROXY_TARGET,
  });
  const resolveProxyAgent = createOpenCodeProxyAgentResolver(resolveProxyTarget);

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

      // Upstream bytes are re-framed per SSE block so `message.updated` /
      // `session.updated` diff bodies (tens of MB each) never reach clients;
      // the boundary tracker observes what was actually written so heartbeats
      // still only land between complete blocks.
      const diffStripper = createSseDiffStripper();
      let upstreamDone = false;
      reader = upstream.body.getReader();
      while (!abortController.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) {
          upstreamDone = true;
          break;
        }
        if (value && value.length > 0) {
          const forwarded = diffStripper.push(value);
          if (forwarded.length === 0) {
            continue;
          }
          sseBoundary.observe(forwarded);
          const canContinue = await enqueueSseWrite(forwarded);
          if (!canContinue) {
            break;
          }
        }
      }

      if (upstreamDone && !abortController.signal.aborted) {
        const tail = diffStripper.flush();
        if (tail.length > 0) {
          sseBoundary.observe(tail);
          await enqueueSseWrite(tail);
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

  // Registers scoped-revert, scoped-unrevert (redo) and the change summary
  // ahead of the generic proxy.
  registerScopedSessionRevertRoute(app, {
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    openCodeSnapshotRoot: deps.openCodeSnapshotRoot,
    openchamberDataDir: deps.openchamberDataDir,
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
      const stripped = records.map(stripMessageDiffContent);
      res.json(stripped);
    } catch {
      if (!res.headersSent) next();
    }
  });

  // OpenCode's OpenAI browser sign-in binds a fixed loopback port and is permanently broken by a
  // single collision on it (see oauth-loopback-preflight.js). Refuse the flow up front rather than
  // letting the user wait out a five-minute callback timeout with no explanation.
  app.post('/api/provider/:providerID/oauth/authorize', async (req, res, next) => {
    if (req.params.providerID !== 'openai') {
      next();
      return;
    }

    try {
      const preflight = await runOAuthLoopbackPreflight();
      if (preflight.reaped.length > 0) {
        console.warn(`[OpenCode] Reaped orphaned OpenCode server(s) holding the OAuth loopback port: ${preflight.reaped.join(', ')}`);
      }
      if (!preflight.ok) {
        res.status(503).json({
          code: 'oauth_loopback_port_busy',
          error: preflight.message,
          retryable: true,
        });
        return;
      }
    } catch (error) {
      // A preflight that cannot run must never block a sign-in that might have worked.
      console.warn('[OpenCode] OAuth loopback preflight failed; continuing:', error?.message ?? error);
    }

    next();
  });

  // Generic proxy for non-SSE OpenCode API routes.
  const apiProxyOptions = defineDynamicProxyAgent({
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
      error: (err, req, res) => {
        console.error('[proxy] OpenCode proxy error:', err.message);
        if (res && !res.headersSent && typeof res.status === 'function') {
          res.status(503).json(isSessionCreateRequest(req) ? creationUnknownPayload() : { error: 'OpenCode service unavailable', retryable: true });
        }
      },
    },
  }, resolveProxyAgent);
  // Managed ownership intercepts this route earlier. For other runtimes, keep
  // create on a bounded, single-dispatch path with unambiguous failure codes.
  app.post('/api/session', async (req, res) => {
    const trace = beginSessionCreationTrace(req);
    if (trace.remainingMs() <= 0) {
      trace.mark('deadline_before_creation');
      return res.status(408).json(creationNotDispatchedPayload());
    }
    trace.mark('upstream_create_started');
    try {
      const rawPath = (req.originalUrl || req.url).replace(/^\/api/, '');
      const response = await fetch(buildOpenCodeUrl(rawPath, ''), {
        method: 'POST', headers: { ...collectForwardProxyHeaders(req.headers, getOpenCodeAuthHeaders()), 'content-type': 'application/json' },
        body: JSON.stringify(req.body ?? {}), signal: AbortSignal.timeout(Math.floor(trace.remainingMs())),
      });
      if (response.status >= 500) {
        await response.body?.cancel();
        trace.mark('outcome_unknown');
        return res.status(response.status).json(creationUnknownPayload());
      }
      const body = await response.text();
      trace.mark(response.ok ? 'acknowledged' : 'upstream_create_rejected');
      return res.status(response.status).type(response.headers.get('content-type') || 'application/json').send(body);
    } catch {
      trace.mark('outcome_unknown');
      return res.status(502).json(creationUnknownPayload());
    }
  });
  const apiProxy = createProxyMiddleware(apiProxyOptions);

  app.use('/api', apiProxy);
};
