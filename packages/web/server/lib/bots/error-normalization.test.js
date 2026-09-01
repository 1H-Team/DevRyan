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
