import { describe, expect, it, mock } from 'bun:test';

import { normalizePullRequestDraft, runFreeZenModelRotation } from './free-zen-generation.js';

describe('free Zen model rotation', () => {
  it('gives every model its own timeout and accepts the final valid result', async () => {
    const request = mock(async ({ model, timeoutMs }) => {
      expect(timeoutMs).toBe(4_500);
      return model === 'free-c' ? 'Useful title' : '';
    });

    const result = await runFreeZenModelRotation({
      models: [{ id: 'free-a' }, { id: 'free-b' }, { id: 'free-c' }],
      timeoutMs: 4_500,
      request,
      accept: (value) => value || null,
    });

    expect(result).toMatchObject({ ok: true, value: 'Useful title', model: 'free-c', attempts: 3 });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('returns sanitized failures after exhausting the complete catalog', async () => {
    const result = await runFreeZenModelRotation({
      models: ['free-a', 'free-b'],
      timeoutMs: 15_000,
      request: mock(async () => {
        const error = new Error('Rate limit exceeded');
        error.status = 429;
        throw error;
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.failures.map((failure) => failure.reason)).toEqual(['rate_limited', 'rate_limited']);
  });
});

describe('PR draft normalization', () => {
  it('extracts a valid JSON object from fenced output', () => {
    expect(normalizePullRequestDraft('```json\n{"title":"Improve title generation","body":"## Summary\\n- Rotate free models"}\n```'))
      .toEqual({ title: 'Improve title generation', body: '## Summary\n- Rotate free models' });
  });

  it('rejects incomplete output', () => {
    expect(normalizePullRequestDraft('{"title":"Missing body"}')).toBeNull();
  });
});
