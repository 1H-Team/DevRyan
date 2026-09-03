import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SESSION_MODEL_TEXT_SESSION_TITLE,
  generateTextWithSessionModel,
} from './session-model-text.js';

const buildOpenCodeUrl = (requestPath) => `http://opencode.test${requestPath}`;

const jsonResponse = (payload, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});

const createFakeOpenCode = ({ replies = [], recovery = null, messageStatus = 200, createStatus = 200 } = {}) => {
  const calls = [];
  let replyIndex = 0;
  const fetchImpl = vi.fn(async (url, init = {}) => {
    const target = new URL(String(url));
    const method = String(init.method || 'GET').toUpperCase();
    calls.push({ path: target.pathname, method, body: init.body ? JSON.parse(String(init.body)) : null, directory: target.searchParams.get('directory') });
    if (target.pathname === '/session' && method === 'POST') {
      return jsonResponse({ id: 'ses_helper' }, createStatus);
    }
    if (target.pathname === '/session/ses_helper/message' && method === 'POST') {
      const reply = replies[replyIndex];
      replyIndex += 1;
      if (typeof reply === 'function') return reply();
      return jsonResponse({ info: { role: 'assistant' }, parts: [{ type: 'text', text: reply ?? '' }] }, messageStatus);
    }
    if (target.pathname === '/session/ses_helper/message' && method === 'GET') {
      return jsonResponse(recovery ?? []);
    }
    if (target.pathname === '/session/ses_helper' && method === 'DELETE') {
      return jsonResponse(true);
    }
    throw new Error(`Unexpected request ${method} ${target.pathname}`);
  });
  return { fetchImpl, calls };
};

const baseOptions = {
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test' }),
  directory: '/repo',
  providerID: 'anthropic',
  modelID: 'claude-sonnet',
  agent: 'devryan-pr',
  prompt: 'Describe the change',
  repairPrompt: 'Return valid JSON this time',
  accept: (text) => (text.startsWith('{') ? JSON.parse(text) : null),
};

describe('generateTextWithSessionModel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a hidden tool-less session, posts the prompt and deletes the session', async () => {
    const fake = createFakeOpenCode({ replies: ['{"title":"Done","body":"## Summary"}'] });
    const result = await generateTextWithSessionModel({ ...baseOptions, fetchImpl: fake.fetchImpl });

    expect(result).toMatchObject({ ok: true, value: { title: 'Done', body: '## Summary' }, attempts: 1, reason: null });
    expect(fake.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /session',
      'POST /session/ses_helper/message',
      'DELETE /session/ses_helper',
    ]);
    expect(fake.calls[0]).toMatchObject({ body: { title: SESSION_MODEL_TEXT_SESSION_TITLE }, directory: '/repo' });
    expect(fake.calls[1].body).toEqual({
      agent: 'devryan-pr',
      model: { providerID: 'anthropic', modelID: 'claude-sonnet' },
      tools: {},
      parts: [{ type: 'text', text: 'Describe the change' }],
    });
    expect(fake.fetchImpl.mock.calls[1][1].headers).toMatchObject({ Authorization: 'Bearer test' });
  });

  it('sends the repair prompt when the first reply is unusable and keeps markdown line breaks', async () => {
    const fake = createFakeOpenCode({
      replies: ['Sure! Here is the description', '{"title":"Fixed","body":"## Summary\\n- line"}'],
    });
    const result = await generateTextWithSessionModel({ ...baseOptions, fetchImpl: fake.fetchImpl });

    expect(result).toMatchObject({ ok: true, attempts: 2, value: { title: 'Fixed', body: '## Summary\n- line' } });
    expect(fake.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/message')).map((call) => call.body.parts[0].text))
      .toEqual(['Describe the change', 'Return valid JSON this time']);
    expect(fake.calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/session/ses_helper' });
  });

  it('reports invalid output after the repair pass and still cleans up', async () => {
    const fake = createFakeOpenCode({ replies: ['nope', 'still nope'] });
    const result = await generateTextWithSessionModel({ ...baseOptions, fetchImpl: fake.fetchImpl });
    expect(result).toMatchObject({ ok: false, reason: 'invalid_output', attempts: 2 });
    expect(fake.calls.at(-1)).toMatchObject({ method: 'DELETE' });
  });

  it('recovers a completed reply after a transport timeout', async () => {
    const timeoutError = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const fake = createFakeOpenCode({
      replies: [() => { throw timeoutError; }],
      recovery: [
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'Describe the change' }] },
        { info: { role: 'assistant' }, parts: [{ type: 'text', text: '{"title":"Recovered","body":"b"}' }] },
      ],
    });
    const result = await generateTextWithSessionModel({ ...baseOptions, fetchImpl: fake.fetchImpl });
    expect(result).toMatchObject({ ok: true, value: { title: 'Recovered', body: 'b' } });
    expect(fake.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /session',
      'POST /session/ses_helper/message',
      'GET /session/ses_helper/message',
      'DELETE /session/ses_helper',
    ]);
  });

  it('reports a timeout when nothing can be recovered', async () => {
    const timeoutError = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    const fake = createFakeOpenCode({ replies: [() => { throw timeoutError; }], recovery: [] });
    const result = await generateTextWithSessionModel({ ...baseOptions, fetchImpl: fake.fetchImpl });
    expect(result).toMatchObject({ ok: false, reason: 'timeout', attempts: 1 });
    expect(fake.calls.at(-1)).toMatchObject({ method: 'DELETE' });
  });

  it('bounds the whole exchange by timeoutMs', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fake = createFakeOpenCode({ replies: ['{"title":"Done","body":"b"}'] });
    await generateTextWithSessionModel({ ...baseOptions, fetchImpl: fake.fetchImpl, timeoutMs: 5_000 });
    const budgets = timeoutSpy.mock.calls.map(([ms]) => ms);
    expect(budgets.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...budgets.slice(0, 2))).toBeLessThanOrEqual(5_000);
  });

  it('classifies provider rejections without sending the repair prompt', async () => {
    const fake = createFakeOpenCode({ replies: ['ignored'], messageStatus: 429 });
    const result = await generateTextWithSessionModel({ ...baseOptions, fetchImpl: fake.fetchImpl });
    expect(result).toMatchObject({ ok: false, reason: 'rate_limited', status: 429, attempts: 1 });
    expect(fake.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/message'))).toHaveLength(1);
  });

  it('fails fast without a runtime URL builder or model', async () => {
    const fake = createFakeOpenCode();
    expect(await generateTextWithSessionModel({ ...baseOptions, fetchImpl: fake.fetchImpl, buildOpenCodeUrl: undefined }))
      .toMatchObject({ ok: false, reason: 'runtime_unavailable' });
    expect(await generateTextWithSessionModel({ ...baseOptions, fetchImpl: fake.fetchImpl, modelID: '' }))
      .toMatchObject({ ok: false, reason: 'model_unavailable' });
    expect(fake.fetchImpl).not.toHaveBeenCalled();
  });
});
