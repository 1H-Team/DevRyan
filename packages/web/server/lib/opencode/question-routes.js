import express from 'express';

export const QUESTION_PARTIAL_HEADER = 'X-DevRyan-Question-Partial';
const DEFAULT_UPSTREAM_TIMEOUT_MS = 1000;

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

const OPEN_CODE_SKIP_ANSWER = 'Skip: continue using your best judgment and explicitly state the assumption you made.';

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
  } = dependencies;

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
      if (!handled) return next();
      return res.json(true);
    } catch (error) {
      logger.error?.('[questions] Failed to reply to a Cursor question:', error);
      return res.status(error instanceof TypeError ? 400 : 500).json({
        error: error instanceof Error ? error.message : 'Failed to reply to Cursor question',
      });
    }
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
