import { describe, expect, it } from 'vitest';

import { normalizeBotRunError } from './error-normalization.js';

describe('Bot run error normalization', () => {
  it('maps DOM timeout code 23 to a stable string code', () => {
    const normalized = normalizeBotRunError(new DOMException('deadline', 'TimeoutError'));
    expect(normalized).toMatchObject({
      code: 'bot_opencode_request_timeout',
      statusCode: 504,
    });
    expect(typeof normalized.code).toBe('string');
  });

  it('distinguishes confirmed cancellation from an unconfirmed abort', () => {
    const aborted = new DOMException('aborted', 'AbortError');
    expect(normalizeBotRunError(aborted)).toMatchObject({
      code: 'bot_opencode_request_aborted',
    });
    expect(normalizeBotRunError(aborted, { cancellationConfirmed: true })).toMatchObject({
      code: 'bot_run_cancelled',
      diagnostics: expect.objectContaining({ retryable: false }),
    });
  });

  it('preserves bounded domain codes and replaces foreign values', () => {
    const domain = Object.assign(new Error('known'), { code: 'bot_revision_conflict' });
    expect(normalizeBotRunError(domain)).toBe(domain);
    expect(normalizeBotRunError(Object.assign(new Error('foreign'), { code: 99 })))
      .toMatchObject({ code: 'bot_agent_run_failed' });
  });
});

describe('Bot error log fields', () => {
  it('projects DOM timeouts, Supabase statuses, and fetch causes into stable codes', async () => {
    const { botErrorLogFields } = await import('./error-normalization.js');
    expect(botErrorLogFields(new DOMException('deadline', 'TimeoutError'), 'x')).toEqual({
      code: 'request_timeout', name: 'TimeoutError',
    });
    const supabase = Object.assign(new Error('rest'), { name: 'SupabaseRequestError', status: 503 });
    expect(botErrorLogFields(supabase, 'fallback')).toEqual({
      code: 'supabase_503', name: 'SupabaseRequestError', status: 503,
    });
    const fetchFailure = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    expect(botErrorLogFields(fetchFailure, 'fallback')).toEqual({ code: 'econnrefused', name: 'TypeError' });
    expect(botErrorLogFields(Object.assign(new Error('domain'), { code: 'bot_revision_conflict', statusCode: 409 }), 'fallback'))
      .toEqual({ code: 'bot_revision_conflict', name: 'Error', status: 409 });
    expect(botErrorLogFields(Object.assign(new Error('foreign'), { code: 99 }), 'fallback_code'))
      .toEqual({ code: 'fallback_code', name: 'Error' });
    expect(botErrorLogFields(null, 'fallback_code')).toEqual({ code: 'fallback_code' });
  });
});
