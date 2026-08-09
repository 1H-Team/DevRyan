import { describe, expect, it, vi } from 'vitest';
import express from 'express';

import request from '../../test-supertest.js';
import { registerQuestionRoutes } from './question-routes.js';

const buildQuestion = (id, sessionID, label = id) => ({
  id,
  sessionID,
  questions: [{
    header: 'Choice',
    question: label,
    options: [
      { label: 'A', description: 'First' },
      { label: 'B', description: 'Second' },
    ],
  }],
});

const createApp = ({
  cursorQuestions = [],
  fetchImpl = vi.fn(async () => new Response('[]', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })),
  replyToQuestion = vi.fn(async () => false),
  rejectQuestion = vi.fn(async () => false),
  emitEvent = vi.fn(),
  upstreamTimeoutMs,
  slowRequestThresholdMs,
} = {}) => {
  const app = express();
  app.use(express.json());
  const logger = { warn: vi.fn(), error: vi.fn() };

  const cursorSdkRuntime = {
    listPendingQuestions: vi.fn(({ directory } = {}) => cursorQuestions.filter(
      (entry) => !directory || entry.directory === directory,
    ).map(({ directory: _directory, ...entry }) => entry)),
    replyToQuestion,
    rejectQuestion,
  };

  registerQuestionRoutes(app, {
    cursorSdkRuntime,
    buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer upstream' }),
    fetchImpl,
    logger,
    emitEvent,
    upstreamTimeoutMs,
    slowRequestThresholdMs,
  });

  app.post('/api/question/:requestID/reply', (req, res) => res.json({ upstream: 'reply', holdMs: req.readinessHoldMs ?? null }));
  app.post('/api/question/:requestID/reject', (req, res) => res.json({ upstream: 'reject' }));

  return { app, cursorSdkRuntime, fetchImpl, replyToQuestion, rejectQuestion, emitEvent, logger };
};

const flushCloseEvents = () => new Promise((resolve) => setImmediate(resolve));

const slowRequestLogCalls = (logger) => logger.warn.mock.calls.filter(
  ([message]) => message === '[questions] slow request',
);

describe('question routes', () => {
  it('merges OpenCode and directory-filtered Cursor questions and deduplicates by session/request identity', async () => {
    const duplicate = buildQuestion('req_same', 'ses_same', 'OpenCode copy');
    const fetchImpl = vi.fn(async (url) => {
      expect(String(url)).toBe('http://opencode.test/question?directory=%2Frepo');
      return new Response(JSON.stringify([
        buildQuestion('req_open', 'ses_open'),
        duplicate,
      ]), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const cursorDuplicate = { ...duplicate, questions: [{ ...duplicate.questions[0], question: 'Cursor copy' }] };
    const { app, cursorSdkRuntime } = createApp({
      fetchImpl,
      cursorQuestions: [
        { ...buildQuestion('req_cursor', 'ses_cursor'), directory: '/repo' },
        { ...cursorDuplicate, directory: '/repo' },
        { ...buildQuestion('req_other', 'ses_other'), directory: '/other' },
      ],
    });

    const response = await request(app).get('/api/question?directory=/repo').expect(200);

    expect(response.body.map((entry) => [entry.sessionID, entry.id])).toEqual([
      ['ses_open', 'req_open'],
      ['ses_same', 'req_same'],
      ['ses_cursor', 'req_cursor'],
    ]);
    expect(response.body[1].questions[0].question).toBe('Cursor copy');
    expect(cursorSdkRuntime.listPendingQuestions).toHaveBeenCalledWith({ directory: '/repo' });
  });

  it('returns Cursor questions with an explicit partial-source header when OpenCode listing fails', async () => {
    const { app } = createApp({
      cursorQuestions: [{ ...buildQuestion('req_cursor', 'ses_cursor'), directory: '/repo' }],
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ error: 'warming up' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })),
    });

    const response = await request(app).get('/api/question?directory=/repo').expect(200);

    expect(response.headers['x-devryan-question-partial']).toBe('opencode');
    expect(response.body.map((entry) => entry.id)).toEqual(['req_cursor']);
  });

  it('bounds a stalled OpenCode listing before returning live Cursor questions', async () => {
    let receivedSignal = null;
    let observedAbort = false;
    const fetchImpl = vi.fn((_url, init = {}) => {
      receivedSignal = init.signal;
      if (!init.signal) return Promise.reject(new Error('missing abort signal'));
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          observedAbort = true;
          reject(init.signal.reason ?? new Error('aborted'));
        }, { once: true });
      });
    });
    const { app } = createApp({
      cursorQuestions: [{ ...buildQuestion('req_cursor', 'ses_cursor'), directory: '/repo' }],
      fetchImpl,
      upstreamTimeoutMs: 10,
    });

    const response = await request(app).get('/api/question?directory=/repo').expect(200);

    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(observedAbort).toBe(true);
    expect(response.headers['x-devryan-question-partial']).toBe('opencode');
    expect(response.body.map((entry) => entry.id)).toEqual(['req_cursor']);
  });

  it('preserves the upstream failure when Cursor has no pending questions', async () => {
    const { app } = createApp({
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ error: 'warming up' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })),
    });

    const response = await request(app).get('/api/question').expect(503);
    expect(response.body).toEqual({ error: 'warming up' });
  });

  it('handles Cursor replies locally and leaves event publication to the runtime', async () => {
    const replyToQuestion = vi.fn(async () => true);
    const emitEvent = vi.fn();
    const { app } = createApp({ replyToQuestion, emitEvent });

    const response = await request(app)
      .post('/api/question/req_cursor/reply?directory=/repo')
      .send({ answers: [['Normalize'], ['Custom answer']] })
      .expect(200);

    expect(response.body).toBe(true);
    expect(replyToQuestion).toHaveBeenCalledWith('req_cursor', [['Normalize'], ['Custom answer']]);
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it('handles Cursor rejection locally and passes unknown request IDs through unchanged', async () => {
    const rejectQuestion = vi.fn(async (requestID) => requestID === 'req_cursor');
    const { app } = createApp({ rejectQuestion });

    const local = await request(app).post('/api/question/req_cursor/reject').expect(200);
    const upstream = await request(app).post('/api/question/req_open/reject').expect(200);

    expect(local.body).toBe(true);
    expect(upstream.body).toEqual({ upstream: 'reject' });
    expect(rejectQuestion).toHaveBeenNthCalledWith(1, 'req_cursor');
    expect(rejectQuestion).toHaveBeenNthCalledWith(2, 'req_open');
  });

  it('resumes a verified OpenCode question turn on Skip with ordered best-judgment answers', async () => {
    const openCodeQuestion = {
      ...buildQuestion('req_open', 'ses_open'),
      questions: [
        ...buildQuestion('req_open', 'ses_open').questions,
        {
          header: 'Compatibility',
          question: 'Which compatibility level?',
          options: [
            { label: 'Strict', description: 'Reject legacy input.' },
            { label: 'Legacy', description: 'Accept legacy input.' },
          ],
        },
      ],
    };
    const fetchImpl = vi.fn(async (url, init = {}) => {
      if (init.method === 'GET') {
        return new Response(JSON.stringify([openCodeQuestion]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      expect(String(url)).toBe('http://opencode.test/question/req_open/reply?directory=%2Frepo');
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({
        Authorization: 'Bearer upstream',
        'Content-Type': 'application/json',
      });
      expect(JSON.parse(String(init.body))).toEqual({
        answers: [
          ['Skip: continue using your best judgment and explicitly state the assumption you made.'],
          ['Skip: continue using your best judgment and explicitly state the assumption you made.'],
        ],
      });
      return new Response('true', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const { app } = createApp({ fetchImpl });

    const response = await request(app)
      .post('/api/question/req_open/reject?directory=/repo')
      .expect(200);

    expect(response.body).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('passes unknown reply IDs through without changing their request body', async () => {
    const { app } = createApp();

    const response = await request(app)
      .post('/api/question/req_open/reply?directory=/repo')
      .send({ answers: [['Throw']] })
      .expect(200);

    expect(response.body).toEqual({ upstream: 'reply', holdMs: null });
  });

  it('logs latency attribution for slow question replies, both Cursor-handled and proxied', async () => {
    const replyToQuestion = vi.fn(async () => true);
    const { app, logger } = createApp({ replyToQuestion, slowRequestThresholdMs: 0 });

    await request(app)
      .post('/api/question/req_cursor/reply')
      .send({ answers: [['A']] })
      .expect(200);
    await request(app)
      .post('/api/question/req_open/reject')
      .send({})
      .expect(200);
    await flushCloseEvents();

    const calls = slowRequestLogCalls(logger);
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toMatchObject({
      method: 'POST',
      url: '/api/question/req_cursor/reply',
      status: 200,
      holdMs: 0,
      proxyMs: null,
    });
    expect(calls[0][1].totalMs).toBeGreaterThanOrEqual(0);
    expect(calls[1][1]).toMatchObject({
      method: 'POST',
      url: '/api/question/req_open/reject',
      status: 200,
    });
  });

  it('stays silent for replies faster than the slow-request threshold', async () => {
    const replyToQuestion = vi.fn(async () => true);
    const { app, logger } = createApp({ replyToQuestion });

    await request(app)
      .post('/api/question/req_cursor/reply')
      .send({ answers: [['A']] })
      .expect(200);
    await flushCloseEvents();

    expect(slowRequestLogCalls(logger)).toHaveLength(0);
  });
});
