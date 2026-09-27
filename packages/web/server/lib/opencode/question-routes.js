import express from 'express';

export const QUESTION_PARTIAL_HEADER = 'X-DevRyan-Question-Partial';
const DEFAULT_UPSTREAM_TIMEOUT_MS = 1000;
const DEFAULT_SLOW_REQUEST_THRESHOLD_MS = 1000;

const jsonParser = express.json({ limit: '64kb' });

const normalizeDirectory = (req) => {
  const directory = typeof req.query.directory === 'string'
    ? req.query.directory.trim()
    : '';
  if (directory) return directory;
  const workspace = typeof req.query.workspace === 'string'
    ? req.query.workspace.trim()
    : '';
  return workspace || null;
};

const questionIdentity = (request) => `${request?.sessionID ?? ''}\0${request?.id ?? ''}`;

const mergeQuestions = (openCodeQuestions, cursorQuestions) => {
  const byIdentity = new Map();
  for (const request of [...openCodeQuestions, ...cursorQuestions]) {
    if (!request?.id || !request?.sessionID) continue;
    const identity = questionIdentity(request);
    if (byIdentity.has(identity)) {
      byIdentity.set(identity, request);
      continue;
    }
    byIdentity.set(identity, request);
  }
  return [...byIdentity.values()];
};

const buildQuestionListPath = (directory) => {
  if (!directory) return '/question';
  const query = new URLSearchParams({ directory });
  return `/question?${query.toString()}`;
};

const buildQuestionReplyPath = (requestID, directory) => {
  const path = `/question/${encodeURIComponent(requestID)}/reply`;
  if (!directory) return path;
  const query = new URLSearchParams({ directory });
  return `${path}?${query.toString()}`;
};

const buildSessionStatusPath = (directory) => {
  if (!directory) return '/session/status';
  const query = new URLSearchParams({ directory });
  return `/session/status?${query.toString()}`;
};

const OPEN_CODE_SKIP_ANSWER = 'Skip: continue using your best judgment and explicitly state the assumption you made.';

export const QUESTION_ORPHANED_CODE = 'question_orphaned';

// OpenCode keeps a question request answerable after its turn is aborted, but
// the reply then reaches a tool call that no longer exists and the answer is
// silently lost. A live question always has its session's turn running, so a
// session OpenCode does not report busy/retry proves the request is orphaned.
const isRunningSessionStatus = (status) => status?.type === 'busy' || status?.type === 'retry';

const readResponsePayload = async (response) => {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const sendUpstreamFailure = (res, failure) => {
  if (failure.response) {
    const payload = failure.payload;
    if (typeof payload === 'string') {
      return res.status(failure.response.status).send(payload);
    }
    return res.status(failure.response.status).json(payload ?? {
      error: `OpenCode question listing failed with status ${failure.response.status}`,
    });
  }
  return res.status(502).json({ error: 'OpenCode question listing is unavailable' });
};

export const registerQuestionRoutes = (app, dependencies) => {
  const {
    cursorSdkRuntime,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders = () => ({}),
    fetchImpl = fetch,
    logger = console,
    upstreamTimeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS,
    slowRequestThresholdMs = DEFAULT_SLOW_REQUEST_THRESHOLD_MS,
  } = dependencies;

  // Latency attribution for question traffic. The same req/res objects flow
  // through the Cursor fall-through, the readiness-hold gate, and the generic
  // OpenCode proxy, so holdMs/proxyMs stamped along the way let a slow reply
  // be blamed on the hold, the upstream, or (if this never fires while the
  // client reports seconds) browser-side connection queueing.
  app.use('/api/question', (req, res, next) => {
    const start = Date.now();
    res.on('close', () => {
      const totalMs = Date.now() - start;
      if (totalMs < slowRequestThresholdMs) return;
      logger.warn?.('[questions] slow request', {
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

  const listOpenCodeQuestions = async (directory) => {
    const upstreamAbortController = new AbortController();
    const timeout = setTimeout(
      () => upstreamAbortController.abort(new Error('OpenCode question listing timed out.')),
      Math.max(1, Number(upstreamTimeoutMs) || DEFAULT_UPSTREAM_TIMEOUT_MS),
    );
    timeout.unref?.();
    try {
      const response = await fetchImpl(buildOpenCodeUrl(buildQuestionListPath(directory), ''), {
        method: 'GET',
        signal: upstreamAbortController.signal,
        headers: {
          Accept: 'application/json',
          ...getOpenCodeAuthHeaders(),
        },
      });
      const payload = await readResponsePayload(response);
      if (!response.ok) return { questions: [], failure: { response, payload } };
      if (!Array.isArray(payload)) {
        return {
          questions: [],
          failure: {
            response: null,
            payload: { error: 'OpenCode returned an invalid question list' },
          },
        };
      }
      return { questions: payload, failure: null };
    } catch (error) {
      return { questions: [], failure: { response: null, payload: null, error } };
    } finally {
      clearTimeout(timeout);
    }
  };

  const readJsonWithinBudget = async (path) => {
    const upstreamAbortController = new AbortController();
    const timeout = setTimeout(
      () => upstreamAbortController.abort(new Error('OpenCode read timed out.')),
      Math.max(1, Number(upstreamTimeoutMs) || DEFAULT_UPSTREAM_TIMEOUT_MS),
    );
    timeout.unref?.();
    try {
      const response = await fetchImpl(buildOpenCodeUrl(path, ''), {
        method: 'GET',
        signal: upstreamAbortController.signal,
        headers: {
          Accept: 'application/json',
          ...getOpenCodeAuthHeaders(),
        },
      });
      if (!response.ok) return null;
      return await readResponsePayload(response);
    } finally {
      clearTimeout(timeout);
    }
  };

  // Resolves to the pending OpenCode request only when its session provably has
  // no running turn. Both reads run in parallel and are small, keeping the reply
  // path fast. Every lookup failure resolves to null so the caller keeps
  // today's pass-through behaviour. Residual: an orphan whose session already
  // runs a newer turn is still forwarded; the DevRyan client discards orphans
  // before it starts a new turn, so only other clients can produce that state.
  const findOrphanedOpenCodeQuestion = async (requestID, directory) => {
    try {
      const [{ questions, failure }, statuses] = await Promise.all([
        listOpenCodeQuestions(directory),
        readJsonWithinBudget(buildSessionStatusPath(directory)).catch(() => null),
      ]);
      if (failure || !statuses || typeof statuses !== 'object' || Array.isArray(statuses)) return null;
      const request = questions.find((entry) => entry?.id === requestID);
      if (typeof request?.sessionID !== 'string') return null;
      return isRunningSessionStatus(statuses[request.sessionID]) ? null : request;
    } catch {
      return null;
    }
  };

  app.get('/api/question', async (req, res) => {
    const directory = normalizeDirectory(req);
    const cursorQuestions = cursorSdkRuntime?.listPendingQuestions?.({ directory }) ?? [];
    const {
      questions: openCodeQuestions,
      failure: upstreamFailure,
    } = await listOpenCodeQuestions(directory);

    if (upstreamFailure) {
      if (cursorQuestions.length === 0) {
        return sendUpstreamFailure(res, upstreamFailure);
      }
      logger.warn?.('[questions] OpenCode listing failed; returning live Cursor questions only.');
      res.setHeader(QUESTION_PARTIAL_HEADER, 'opencode');
      return res.json(mergeQuestions([], cursorQuestions));
    }

    return res.json(mergeQuestions(openCodeQuestions, cursorQuestions));
  });

  app.post('/api/question/:requestID/reply', jsonParser, async (req, res, next) => {
    try {
      const handled = await cursorSdkRuntime?.replyToQuestion?.(
        req.params.requestID,
        req.body?.answers,
      );
      if (handled) return res.json(true);
    } catch (error) {
      logger.error?.('[questions] Failed to reply to a Cursor question:', error);
      return res.status(error instanceof TypeError ? 400 : 500).json({
        error: error instanceof Error ? error.message : 'Failed to reply to Cursor question',
      });
    }

    const orphaned = await findOrphanedOpenCodeQuestion(req.params.requestID, normalizeDirectory(req));
    if (!orphaned) return next();
    return res.status(409).json({
      code: QUESTION_ORPHANED_CODE,
      error: 'This question belongs to a turn that already stopped; the answer would not reach the agent.',
    });
  });

  app.post('/api/question/:requestID/reject', async (req, res, next) => {
    try {
      const handled = await cursorSdkRuntime?.rejectQuestion?.(req.params.requestID);
      if (handled) return res.json(true);

      const directory = normalizeDirectory(req);
      const { questions, failure } = await listOpenCodeQuestions(directory);
      if (failure) return next();
      const request = questions.find((entry) => entry?.id === req.params.requestID);
      if (!request || !Array.isArray(request.questions) || request.questions.length === 0) {
        return next();
      }

      const response = await fetchImpl(
        buildOpenCodeUrl(buildQuestionReplyPath(req.params.requestID, directory), ''),
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            ...getOpenCodeAuthHeaders(),
          },
          body: JSON.stringify({
            answers: request.questions.map(() => [OPEN_CODE_SKIP_ANSWER]),
          }),
        },
      );
      const payload = await readResponsePayload(response);
      if (typeof payload === 'string') return res.status(response.status).send(payload);
      return res.status(response.status).json(payload ?? response.ok);
    } catch (error) {
      logger.error?.('[questions] Failed to skip a question:', error);
      return res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to skip question',
      });
    }
  });
};
