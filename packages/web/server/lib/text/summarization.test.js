import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ZenApiError,
  generateZenText,
  isUnavailableZenModelError,
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
});
