import { describe, expect, it, vi } from 'vitest';
import { createBotFailureRecorder } from './failure-diagnostics.js';

describe('scoped Bot failure journal', () => {
  it('retains bounded correlation and provider evidence without headers or bodies', () => {
    const record = vi.fn();
    createBotFailureRecorder(record)({
      event: 'bot.provider.failed', run: { id: 'run-1', botId: 'bot-1', channelId: 'channel-1' },
      sessionId: 'ses_1', stage: 'session.error', reason: 'provider_api',
      error: { name: 'APIError', data: {
        message: `Provider failed token=private-secret-value ${'x'.repeat(2000)}`,
        statusCode: 429, requestId: 'req_123', isRetryable: true,
        responseHeaders: { authorization: 'header-secret' }, responseBody: 'body-secret',
      } },
    });
    expect(record).toHaveBeenCalledTimes(1);
    expect(record.mock.calls[0][0]).toMatchObject({
      type: 'lifecycle', event: 'bot.provider.failed', sessionID: 'ses_1',
      payload: { runId: 'run-1', botId: 'bot-1', channelId: 'channel-1', stage: 'session.error',
        error: { name: 'APIError', statusCode: 429, ref: 'req_123', retry: true } },
    });
    const payload = record.mock.calls[0][0].payload;
    expect(payload.error.message.length).toBeLessThanOrEqual(1024);
    for (const secret of ['private-secret-value', 'header-secret', 'body-secret', 'responseHeaders', 'responseBody']) {
      expect(JSON.stringify(payload)).not.toContain(secret);
    }
  });

  it('records action and transport stage without leaking unstructured metadata', () => {
    const record = vi.fn();
    createBotFailureRecorder(record)({ event: 'bot.browser.recovery', run: { id: 'run-1' },
      operationId: 'action-1', stage: 'runtime_restart_failed',
      error: { code: 'bot_runtime_supervisor_unavailable',
        diagnostics: { stage: 'supervisor_request', reason: 'ECONNREFUSED', secret: 'private' } },
    });
    expect(record.mock.calls[0][0].payload).toMatchObject({ operationId: 'action-1',
      stage: 'runtime_restart_failed', error: { stage: 'supervisor_request', reason: 'ECONNREFUSED' } });
    expect(JSON.stringify(record.mock.calls)).not.toContain('private');
    expect(() => createBotFailureRecorder(() => { throw new Error('disk'); })({
      event: 'bot.provider.failed', stage: 'session.error', error: new Error('provider'),
    })).not.toThrow();
  });
});
