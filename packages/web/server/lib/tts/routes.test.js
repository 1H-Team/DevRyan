import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from '../../test-supertest.js';

import { registerTtsRoutes } from './routes.js';

const createApp = (sayTTSCapability = null) => {
  const app = express();
  app.use(express.json());
  registerTtsRoutes(app, {
    resolveZenModel: async () => 'gpt-5-nano',
    sayTTSCapability,
  });
  return app;
};

describe('tts routes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retries note summarization with notification mode before failing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: 'unavailable' }),
    })));

    const response = await request(createApp())
      .post('/api/text/summarize')
      .send({
        text: 'First sentence. Second sentence with the useful insight.',
        threshold: 0,
        maxLength: 100,
        mode: 'note',
      });

    expect(response.status).toBe(502);
    // Two modes attempted, each retrying the transient 503 once.
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(response.body).toEqual({
      error: 'Note summarization failed',
      reason: 'Zen API returned 503: unavailable',
    });
  });

  it('uses notification summarizer result when note mode falls back', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({ error: 'unavailable' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          output: [{
            type: 'message',
            content: [{ type: 'output_text', text: '**Keep provider state stable** during streaming.' }],
          }],
        }),
      }));

    const response = await request(createApp())
      .post('/api/text/summarize')
      .send({
        text: 'First sentence. Preserve provider state references during streaming to avoid wide rerenders.',
        threshold: 0,
        maxLength: 100,
        mode: 'note',
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      summary: 'Keep provider state stable during streaming.',
      summarized: true,
    });
  });

  it('keeps notification fallback behavior', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: 'unavailable' }),
    })));

    const response = await request(createApp())
      .post('/api/text/summarize')
      .send({
        text: 'Notification text that should fall back cleanly.',
        threshold: 0,
        maxLength: 100,
        mode: 'notification',
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      summary: 'Notification text that should fall back cleanly.',
      summarized: false,
      reason: 'Zen API returned 503: unavailable',
    });
  });

  it('reports macOS playback unavailable when say capability is missing', async () => {
    const response = await request(createApp())
      .post('/api/tts/say/speak')
      .send({ text: 'Hello' });

    expect(response.status).toBe(503);
    expect(response.body.error).toBeTruthy();
  });

  it('rejects unsupported macOS say voices before command execution', async () => {
    const response = await request(createApp({
      available: true,
      voices: [{ name: 'Samantha', locale: 'en_US' }],
    }))
      .post('/api/tts/say/speak')
      .send({ text: 'Hello', voice: 'BadVoice' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Unsupported macOS voice' });
  });

  it('rejects invalid macOS say speech rates', async () => {
    const response = await request(createApp({
      available: true,
      voices: [{ name: 'Samantha', locale: 'en_US' }],
    }))
      .post('/api/tts/say/speak')
      .send({ text: 'Hello', voice: 'Samantha', rate: 'fast' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Rate must be a number' });
  });
});
