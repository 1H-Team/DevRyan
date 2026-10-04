import { createNativeConsumerFixture } from './test-native-consumer-client.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import express from 'express';

import { createLoopbackOpenCodeFixtureForGeneration } from '../../../../../scripts/perf/loopback-opencode-fixtures.mjs';
import { PERF_CHILD_SESSION_IDS } from '../../../../../scripts/perf/fixture-session-seeds.mjs';
import request from '../../test-supertest.js';
import { createOpenCodeClient } from './opencode-client/index.js';
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
    openCodeClient: createNativeConsumerFixture({ readFixture: fetchImpl, headers: () => ({ Authorization: 'Bearer upstream' }) }),
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
    expect(response.body).toEqual({ error: 'Native fixture request refused', code: 'opencode_http_error' });
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

  describe('orphaned OpenCode questions', () => {
    const toolQuestion = {
      ...buildQuestion('req_open', 'ses_open'),
      tool: { messageID: 'msg_asst', callID: 'call_q' },
    };
    const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
    const createStatusFetch = (statuses) => vi.fn(async (url) => {
      const target = String(url);
      if (target.startsWith('http://opencode.test/question?')) return json([toolQuestion]);
      if (target.startsWith('http://opencode.test/session/status')) {
        expect(target).toBe('http://opencode.test/session/status');
        return json(statuses);
      }
      throw new Error(`unexpected upstream call ${target}`);
    });

    it('refuses a reply whose session has no running turn, without forwarding it', async () => {
      const fetchImpl = createStatusFetch({ ses_other: { type: 'busy' } });
      const { app } = createApp({ fetchImpl });

      const response = await request(app)
        .post('/api/question/req_open/reply?directory=/repo')
        .send({ answers: [['A']] })
        .expect(409);

      expect(response.body).toMatchObject({ code: 'question_orphaned' });
      // Only the two small reads; the reply itself never reaches OpenCode.
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('forwards a reply while the session turn is running or retrying', async () => {
      for (const type of ['busy', 'retry']) {
        const { app } = createApp({ fetchImpl: createStatusFetch({ ses_open: { type } }) });
        const response = await request(app)
          .post('/api/question/req_open/reply?directory=/repo')
          .send({ answers: [['A']] })
          .expect(200);
        expect(response.body).toEqual({ upstream: 'reply', holdMs: null });
      }
    });

    it('fails open to forwarding when the session status cannot be read in time', async () => {
      const fetchImpl = vi.fn(async (url, init = {}) => {
        if (String(url).startsWith('http://opencode.test/question?')) return json([toolQuestion]);
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal.reason));
        });
      });
      const { app } = createApp({ fetchImpl, upstreamTimeoutMs: 5 });

      const response = await request(app)
        .post('/api/question/req_open/reply?directory=/repo')
        .send({ answers: [['A']] })
        .expect(200);

      expect(response.body).toEqual({ upstream: 'reply', holdMs: null });
    });

    it('fails open when the status payload is malformed', async () => {
      const { app } = createApp({ fetchImpl: createStatusFetch(['not', 'a', 'map']) });
      await request(app)
        .post('/api/question/req_open/reply?directory=/repo')
        .send({ answers: [['A']] })
        .expect(200);
    });
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

// ---------------------------------------------------------------------------
// Generation 2: OpenCode questions are forms behind the client's interaction
// projection (DESIGN.md B.6, E item 13c).

describe('question routes (generation 2)', () => {
  const clientError = (statusCode, code, message = `failed (${statusCode})`) => Object.assign(new Error(message), { statusCode, code });
  const unexpectedFetch = vi.fn(async (url) => { throw new Error(`unexpected raw fetch ${url}`); });

  const createFakeClient = ({ questions = [], statuses = {}, reply = async () => true } = {}) => ({
    generation: () => 2,
    interaction: {
      questions: {
        list: vi.fn(async () => {
          if (questions instanceof Error) throw questions;
          return questions;
        }),
        reply: vi.fn(reply),
        reject: vi.fn(async () => true),
      },
    },
    sessions: {
      status: vi.fn(async () => {
        if (statuses instanceof Error) throw statuses;
        return statuses;
      }),
    },
  });

  const createV2App = ({ openCodeClient, cursorQuestions = [], upstreamTimeoutMs } = {}) => {
    const app = express();
    app.use(express.json());
    const logger = { warn: vi.fn(), error: vi.fn() };
    registerQuestionRoutes(app, {
      cursorSdkRuntime: {
        listPendingQuestions: vi.fn(() => cursorQuestions),
        replyToQuestion: vi.fn(async () => false),
        rejectQuestion: vi.fn(async () => false),
      },
      buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
      fetchImpl: unexpectedFetch,
      openCodeClient,
      logger,
      upstreamTimeoutMs,
    });
    app.post('/api/question/:requestID/reply', (_req, res) => res.json({ upstream: 'reply' }));
    app.post('/api/question/:requestID/reject', (_req, res) => res.json({ upstream: 'reject' }));
    return { app, logger };
  };

  it('lists projected form questions through the client and merges Cursor questions', async () => {
    const client = createFakeClient({ questions: [buildQuestion('frm_open', 'ses_open')] });
    const { app } = createV2App({ openCodeClient: client, cursorQuestions: [buildQuestion('req_cursor', 'ses_cursor')] });

    const response = await request(app).get('/api/question?directory=/repo').expect(200);

    expect(response.body.map((entry) => entry.id)).toEqual(['frm_open', 'req_cursor']);
    expect(client.interaction.questions.list).toHaveBeenCalledWith({ directory: '/repo' }, { signal: expect.any(AbortSignal) });
    expect(unexpectedFetch).not.toHaveBeenCalled();
  });

  it('keeps the client status and typed code when the listing fails and Cursor has nothing', async () => {
    const client = createFakeClient({ questions: clientError(400, 'opencode_location_required', 'questions.list: location required') });
    const { app } = createV2App({ openCodeClient: client });

    const response = await request(app).get('/api/question').expect(400);
    expect(response.body).toEqual({ error: 'questions.list: location required', code: 'opencode_location_required' });

    const partial = createV2App({ openCodeClient: createFakeClient({ questions: clientError(503, 'opencode_unavailable') }),
      cursorQuestions: [buildQuestion('req_cursor', 'ses_cursor')] });
    const merged = await request(partial.app).get('/api/question?directory=/repo').expect(200);
    expect(merged.headers['x-devryan-question-partial']).toBe('opencode');
    expect(merged.body.map((entry) => entry.id)).toEqual(['req_cursor']);
  });

  it('bounds a stalled client listing with the upstream budget', async () => {
    let observedAbort = false;
    const client = createFakeClient();
    client.interaction.questions.list = vi.fn((_query, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { observedAbort = true; reject(signal.reason); }, { once: true });
    }));
    const { app } = createV2App({ openCodeClient: client, upstreamTimeoutMs: 10 });

    const response = await request(app).get('/api/question?directory=/repo').expect(502);
    expect(observedAbort).toBe(true);
    expect(response.body).toEqual({ error: 'OpenCode question listing is unavailable' });
  });

  it('refuses an orphaned reply from all active sessions and forwards a live one', async () => {
    const question = buildQuestion('frm_open', 'ses_open');
    const orphan = createFakeClient({ questions: [question], statuses: { ses_other: { type: 'busy' } } });
    const refused = await request(createV2App({ openCodeClient: orphan }).app)
      .post('/api/question/frm_open/reply?directory=/repo').send({ answers: [['A']] }).expect(409);
    expect(refused.body).toMatchObject({ code: 'question_orphaned' });
    // Every active session is read, never a directory-filtered map.
    expect(orphan.sessions.status).toHaveBeenCalledWith({}, { signal: expect.any(AbortSignal) });
    expect(orphan.interaction.questions.reply).not.toHaveBeenCalled();

    for (const type of ['busy', 'retry']) {
      const live = createFakeClient({ questions: [question], statuses: { ses_open: { type } } });
      const forwarded = await request(createV2App({ openCodeClient: live }).app)
        .post('/api/question/frm_open/reply?directory=/repo').send({ answers: [['A']] }).expect(200);
      expect(forwarded.body).toEqual({ upstream: 'reply' });
    }

    const unknown = createFakeClient({ questions: [question], statuses: clientError(503, 'opencode_unavailable') });
    const failOpen = await request(createV2App({ openCodeClient: unknown }).app)
      .post('/api/question/frm_open/reply?directory=/repo').send({ answers: [['A']] }).expect(200);
    expect(failOpen.body).toEqual({ upstream: 'reply' });
  });

  it('skips through a client reply with one best-judgment answer per question', async () => {
    const question = {
      ...buildQuestion('frm_open', 'ses_open'),
      questions: [...buildQuestion('frm_open', 'ses_open').questions, ...buildQuestion('frm_open', 'ses_open', 'second').questions],
    };
    const client = createFakeClient({ questions: [question] });

    const response = await request(createV2App({ openCodeClient: client }).app).post('/api/question/frm_open/reject?directory=/repo').expect(200);

    expect(response.body).toBe(true);
    expect(client.interaction.questions.reply).toHaveBeenCalledWith('frm_open', {
      answers: [
        ['Skip: continue using your best judgment and explicitly state the assumption you made.'],
        ['Skip: continue using your best judgment and explicitly state the assumption you made.'],
      ],
    }, { directory: '/repo', sessionID: 'ses_open' });
  });

  it('falls through to the plain reject when the form cannot take free text, and reports other failures', async () => {
    const question = buildQuestion('frm_open', 'ses_open');
    const fixedOptions = createFakeClient({ questions: [question], reply: async () => { throw clientError(400, 'opencode_invalid_input'); } });
    const fallThrough = await request(createV2App({ openCodeClient: fixedOptions }).app).post('/api/question/frm_open/reject?directory=/repo').expect(200);
    expect(fallThrough.body).toEqual({ upstream: 'reject' });

    const settled = createFakeClient({ questions: [question], reply: async () => { throw clientError(409, 'opencode_conflict', 'already settled'); } });
    const conflict = await request(createV2App({ openCodeClient: settled }).app).post('/api/question/frm_open/reject?directory=/repo').expect(409);
    expect(conflict.body).toEqual({ error: 'already settled', code: 'opencode_conflict' });

    const unknown = await request(createV2App({ openCodeClient: createFakeClient() }).app).post('/api/question/frm_missing/reject').expect(200);
    expect(unknown.body).toEqual({ upstream: 'reject' });
  });

  it('serves the routes against the gen-2 fixture through the real client', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'devryan-question-routes-'));
    const fixture = await createLoopbackOpenCodeFixtureForGeneration(2, { directory, heartbeatMs: 50 });
    try {
      const openCodeClient = createOpenCodeClient({
        getRuntime: () => ({ generation: 2, baseUrl: fixture.origin }),
        getAuthHeaders: () => ({ ...fixture.authHeaders }),
      });
      const { app } = createV2App({ openCodeClient, upstreamTimeoutMs: 5_000 });
      const [sessionID] = PERF_CHILD_SESSION_IDS;
      const formID = fixture.askQuestion(sessionID);
      const query = `directory=${encodeURIComponent(directory)}`;

      const listed = await request(app).get(`/api/question?${query}`).expect(200);
      expect(listed.body).toEqual([expect.objectContaining({ id: formID, sessionID })]);
      expect(listed.body[0].questions[0]).toMatchObject({ question: 'Which implementation should be used?', custom: true });

      // The fixture session runs no turn, so a reply would be lost.
      const orphaned = await request(app).post(`/api/question/${formID}/reply?${query}`).send({ answers: [['Sort by priority']] }).expect(409);
      expect(orphaned.body.code).toBe('question_orphaned');

      await request(app).post(`/api/question/${formID}/reject?${query}`).expect(200);
      const recorded = fixture.getState().replies.filter((reply) => reply.type === 'question');
      expect(recorded).toEqual([expect.objectContaining({ requestID: formID, sessionID,
        answers: [['Skip: continue using your best judgment and explicitly state the assumption you made.']] })]);
      expect((await request(app).get(`/api/question?${query}`).expect(200)).body).toEqual([]);
    } finally {
      await fixture.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
