import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ZenApiError,
  __resetZenModelCooldowns,
  generateZenText,
  isTransientZenError,
  isUnavailableZenModelError,
  isUnusableZenModelError,
  sanitizeForTitle,
  summarizeText,
} from './summarization.js';

const originalFetch = globalThis.fetch;

function stubFetch(fetchMock) {
  globalThis.fetch = fetchMock;
}

describe('text summarization zen requests', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    // Rate-limit cooldowns are module-level by design (they must outlive a
    // single call), so tests have to clear them between cases.
    __resetZenModelCooldowns();
  });

  it('uses responses endpoint for gpt models', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text: 'Short summary' }],
        }],
      }),
    }));
    stubFetch(fetchMock);

    const result = await summarizeText({
      text: 'Long text '.repeat(30),
      threshold: 0,
      maxLength: 100,
      zenModel: 'gpt-5-nano',
      mode: 'notification',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://opencode.ai/zen/v1/responses',
      expect.objectContaining({
        body: expect.stringContaining('"input"'),
      }),
    );
    expect(result.summary).toBe('Short summary');
  });

  it('uses the strict concise-title contract for session title generation', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text: 'Fix OpenAI session titles.' }],
        }],
      }),
    }));
    stubFetch(fetchMock);

    const result = await summarizeText({
      text: 'Investigate why OpenAI session titles remain untitled',
      threshold: 0,
      maxLength: 80,
      zenModel: 'gpt-5-nano',
      mode: 'title',
    });

    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody.input[0].content).toContain('3 to 7 words');
    expect(result.summary).toBe('Fix OpenAI session titles');
  });

  it('drops standalone plan control markers and keeps the first valid title line', () => {
    expect(sanitizeForTitle('<!--plan-->')).toBe('');
    expect(sanitizeForTitle('<-----plan------>')).toBe('');
    expect(sanitizeForTitle('<!-- plan -->\nFix Anthropic session titles.')).toBe('Fix Anthropic session titles');
    expect(sanitizeForTitle('Review plan rendering')).toBe('Review plan rendering');
  });

  it('uses chat completions endpoint for openai-compatible zen models', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Chat summary' } }],
      }),
    }));
    stubFetch(fetchMock);

    const result = await summarizeText({
      text: 'Long text '.repeat(30),
      threshold: 0,
      maxLength: 100,
      zenModel: 'big-pickle',
      mode: 'notification',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://opencode.ai/zen/v1/chat/completions',
      expect.objectContaining({
        body: expect.stringContaining('"messages"'),
      }),
    );
    expect(result.summary).toBe('Chat summary');
  });

  it('returns direct text from responses without creating a session request', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text: 'fix(ui): generate commit subject' }],
        }],
      }),
    }));
    stubFetch(fetchMock);

    const result = await generateZenText({
      prompt: 'Generate a commit subject',
      zenModel: 'gpt-5-nano',
      responsesMaxOutputTokens: 128,
    });

    expect(result).toBe('fix(ui): generate commit subject');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://opencode.ai/zen/v1/responses');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ max_output_tokens: 128 });
    expect(String(fetchMock.mock.calls[0][0])).not.toMatch(/session|prompt_async/);
  });

  it('returns direct text from chat completions', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'chore: update generated files' } }],
      }),
    }));
    stubFetch(fetchMock);

    await expect(generateZenText({
      prompt: 'Generate a commit subject',
      zenModel: 'big-pickle',
      chatMaxTokens: 64,
      chatReasoningEffort: 'none',
      stop: ['\n'],
    })).resolves.toBe('chore: update generated files');
    expect(fetchMock.mock.calls[0][0]).toBe('https://opencode.ai/zen/v1/chat/completions');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      max_tokens: 64,
      reasoning_effort: 'none',
      stop: ['\n'],
    });
  });

  it('classifies only explicit unavailable-model responses as retryable', () => {
    expect(isUnavailableZenModelError(new ZenApiError(404, 'model not found'))).toBe(true);
    expect(isUnavailableZenModelError(new ZenApiError(400, 'unknown model name'))).toBe(true);
    expect(isUnavailableZenModelError(new ZenApiError(429, 'model rate limited'))).toBe(false);
    expect(isUnavailableZenModelError(new ZenApiError(500, 'model unavailable'))).toBe(false);
    expect(isUnavailableZenModelError(new Error('model unavailable'))).toBe(false);
  });

  it('clamps successful model summaries to the requested max length', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text: 'This response is too long' }],
        }],
      }),
    }));
    stubFetch(fetchMock);

    const result = await summarizeText({
      text: 'Long text '.repeat(30),
      threshold: 0,
      maxLength: 12,
      zenModel: 'gpt-5-nano',
      mode: 'notification',
    });

    expect(result.summary).toBe('This respons');
    expect(result.summaryLength).toBe(12);
  });

  it('does not clamp successful model summaries for non-finite max lengths', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text: 'Full response' }],
        }],
      }),
    }));
    stubFetch(fetchMock);

    const result = await summarizeText({
      text: 'Long text '.repeat(30),
      threshold: 0,
      maxLength: Infinity,
      zenModel: 'gpt-5-nano',
      mode: 'notification',
    });

    expect(result.summary).toBe('Full response');
    expect(result.summaryLength).toBe(13);
  });

  it('retries the same model once after a transient failure', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'Recovered title' } }] }),
      });
    stubFetch(fetchMock);

    const result = await summarizeText({
      text: 'Long text '.repeat(30),
      threshold: 0,
      maxLength: 80,
      zenModel: 'deepseek-v4-flash-free',
      retryDelayMs: 0,
      mode: 'title',
    });
    consoleError.mockRestore();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ summary: 'Recovered title', summarized: true, attempts: 2 });
  });

  it('switches to the fallback model when the primary one is unavailable', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ error: { message: 'The model `retired-free` is not found' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'Fallback title' } }] }),
      });
    stubFetch(fetchMock);

    const result = await summarizeText({
      text: 'Long text '.repeat(30),
      threshold: 0,
      maxLength: 80,
      zenModel: 'retired-free',
      fallbackZenModel: 'deepseek-v4-flash-free',
      retryDelayMs: 0,
      mode: 'title',
    });
    consoleError.mockRestore();

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('retired-free');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).model).toBe('deepseek-v4-flash-free');
    expect(result).toMatchObject({ summarized: true, usedFallbackModel: true });
  });

  // Behaviour change (2026-08-21): a rate-limited model used to be retried once
  // before advancing. Live logs showed that retry is near-worthless — the Zen
  // fallback answered 429 on attempts 2 AND 3 of every one of 23 consecutive
  // title generations. When another model is available we now advance to it
  // immediately and put the rate-limited one in cooldown.
  it('advances to the next model immediately on a rate limit', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'Second model title' } }] }),
      });
    stubFetch(fetchMock);

    const result = await summarizeText({
      text: 'Long text '.repeat(30),
      threshold: 0,
      maxLength: 80,
      zenModel: 'primary-free',
      fallbackZenModel: 'secondary-free',
      retryDelayMs: 0,
      mode: 'title',
    });
    consoleError.mockRestore();

    expect(fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body).model))
      .toEqual(['primary-free', 'secondary-free']);
    expect(result.summary).toBe('Second model title');
  });

  it('still retries the same model on a rate limit when it is the only one', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'Only model title' } }] }),
      });
    stubFetch(fetchMock);

    const result = await summarizeText({
      text: 'Long text '.repeat(30),
      threshold: 0,
      maxLength: 80,
      zenModel: 'only-free',
      retryDelayMs: 0,
      mode: 'title',
    });
    consoleError.mockRestore();

    expect(fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body).model))
      .toEqual(['only-free', 'only-free']);
    expect(result.summary).toBe('Only model title');
  });

  it('rotates through every model in zenModelRotation', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn()
      // deepseek-v4-flash-free: the exact 401 seen live all day on 2026-08-21.
      .mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({ error: 'Free promotion has ended' }) })
      .mockResolvedValueOnce({ ok: false, status: 429, json: async () => ({}) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'Third model title' } }] }),
      });
    stubFetch(fetchMock);

    const result = await summarizeText({
      text: 'Long text '.repeat(30),
      threshold: 0,
      maxLength: 80,
      zenModel: 'deepseek-v4-flash-free',
      zenModelRotation: ['big-pickle', 'third-free'],
      retryDelayMs: 0,
      mode: 'title',
    });
    consoleError.mockRestore();

    expect(fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body).model))
      .toEqual(['deepseek-v4-flash-free', 'big-pickle', 'third-free']);
    expect(result).toMatchObject({ summarized: true, model: 'third-free' });
  });

  it('skips a model that is still cooling down from an earlier rate limit', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch(vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) }));
    await summarizeText({
      text: 'Long text '.repeat(30),
      threshold: 0,
      maxLength: 80,
      zenModel: 'hot-model',
      retryDelayMs: 0,
      mode: 'title',
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Cool model title' } }] }),
    });
    stubFetch(fetchMock);

    const result = await summarizeText({
      text: 'Long text '.repeat(30),
      threshold: 0,
      maxLength: 80,
      zenModel: 'hot-model',
      zenModelRotation: ['cool-model'],
      retryDelayMs: 0,
      mode: 'title',
    });
    consoleError.mockRestore();

    // hot-model is skipped entirely rather than burning another attempt.
    expect(fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body).model))
      .toEqual(['cool-model']);
    expect(result.summary).toBe('Cool model title');
  });

  it('does not retry a non-transient failure against the same model', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: 'Unauthorized' } }),
    }));
    stubFetch(fetchMock);

    const result = await summarizeText({
      text: 'Long text '.repeat(30),
      threshold: 0,
      maxLength: 80,
      zenModel: 'deepseek-v4-flash-free',
      retryDelayMs: 0,
      mode: 'title',
    });
    consoleError.mockRestore();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.summarized).toBe(false);
  });

  it('ignores a fallback model identical to the primary one', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    stubFetch(fetchMock);

    await summarizeText({
      text: 'Long text '.repeat(30),
      threshold: 0,
      maxLength: 80,
      zenModel: 'deepseek-v4-flash-free',
      fallbackZenModel: '  deepseek-v4-flash-free  ',
      retryDelayMs: 0,
      mode: 'title',
    });
    consoleError.mockRestore();

    // One attempt plus one same-model retry; no third attempt against itself.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('switches models when the primary one is served but not entitled', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: { message: 'Missing API key.' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'Entitled model title' } }] }),
      });
    stubFetch(fetchMock);

    const result = await summarizeText({
      text: 'Long text '.repeat(30),
      threshold: 0,
      maxLength: 80,
      zenModel: 'gpt-5-nano',
      fallbackZenModel: 'deepseek-v4-flash-free',
      retryDelayMs: 0,
      mode: 'title',
    });
    consoleError.mockRestore();

    // A 401 is permanent for that model id, so it must not be retried as-is.
    expect(fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body).model))
      .toEqual(['gpt-5-nano', 'deepseek-v4-flash-free']);
    expect(result).toMatchObject({ summary: 'Entitled model title', summarized: true, usedFallbackModel: true });
  });

  it('classifies models we cannot use separately from retryable failures', () => {
    expect(isUnusableZenModelError(new ZenApiError(401, 'Missing API key.'))).toBe(true);
    expect(isUnusableZenModelError(new ZenApiError(403, 'Forbidden'))).toBe(true);
    expect(isUnusableZenModelError(new ZenApiError(404, 'model not found'))).toBe(true);
    expect(isUnusableZenModelError(new ZenApiError(429, 'slow down'))).toBe(false);
    expect(isUnusableZenModelError(new Error('Zen generation timed out'))).toBe(false);
  });

  it('classifies retryable transport and upstream failures', () => {
    expect(isTransientZenError(new ZenApiError(429, 'slow down'))).toBe(true);
    expect(isTransientZenError(new ZenApiError(503, 'upstream'))).toBe(true);
    expect(isTransientZenError(new ZenApiError(401, 'nope'))).toBe(false);
    expect(isTransientZenError(new Error('Zen generation timed out'))).toBe(true);
    expect(isTransientZenError(new TypeError('fetch failed'))).toBe(true);
    expect(isTransientZenError(new Error('bad prompt'))).toBe(false);
  });

  it('still falls back to source text for non-title modes', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    stubFetch(fetchMock);

    const result = await summarizeText({
      text: 'Deploy finished successfully',
      threshold: 0,
      maxLength: 80,
      zenModel: 'gpt-5-nano',
      retryDelayMs: 0,
      mode: 'notification',
    });
    consoleError.mockRestore();

    expect(result.summarized).toBe(false);
    expect(result.summary).toBe('Deploy finished successfully');
  });
});
