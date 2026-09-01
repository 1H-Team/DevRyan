import React, { act } from 'react';
import { describe, expect, test } from 'bun:test';
import { botsApi, type BotsApi, type BotSpeechStatus } from '@/lib/botsApi';
import { withDom } from '@/components/bots/chat/botMountedDom';
import { BotSpeechSettings } from './BotSpeechSettings';

const status: BotSpeechStatus = { botId: 'bot', enabled: true, generation: 'generation', stt: { baseUrl: 'https://speech.example/v1', model: 'transcriber', hasApiKey: true, ready: true }, tts: null, limits: { maximumInputSeconds: 300, maximumInputBytes: 20 * 1024 * 1024, maximumReplyCharacters: 4000 } };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };

describe('mounted Bot speech settings', () => {
  test('loads only while opened and keeps absent providers and saved API keys safe', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element); let loads = 0;
    const api: BotsApi = { ...botsApi, getSpeechStatus: async () => { loads += 1; return status; } };
    try {
      await act(async () => { root.render(<BotSpeechSettings botId="bot" active api={api} />); }); expect(loads).toBe(0);
      await act(async () => { container.find((node) => node.tagName === 'DETAILS')?.toggle(true); });
      expect(loads).toBe(1); expect(container.textContent).toContain('Incoming transcription · Configured'); expect(container.textContent).toContain('Spoken replies · Not ready');
      expect(container.find((node) => node.tagName === 'INPUT' && node.type === 'password')?.value).toBe('');
    } finally { await act(async () => { root.unmount(); }); }
  }));

  test('reopening disables old controls until the fresh status arrives', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element); let loads = 0;
    const refresh = deferred<BotSpeechStatus>();
    const api: BotsApi = { ...botsApi, getSpeechStatus: async () => ++loads === 1 ? status : refresh.promise };
    try {
      await act(async () => { root.render(<BotSpeechSettings botId="bot" active api={api} />); });
      await act(async () => { container.find((node) => node.tagName === 'DETAILS')?.toggle(true); });
      await act(async () => { container.find((node) => node.tagName === 'DETAILS')?.toggle(false); });
      await act(async () => { container.find((node) => node.tagName === 'DETAILS')?.toggle(true); });
      expect(container.find((node) => node.tagName === 'FIELDSET')?.hasAttribute('disabled')).toBe(true);
      await act(async () => { refresh.resolve({ ...status, stt: null }); });
      expect(container.find((node) => node.tagName === 'FIELDSET')?.hasAttribute('disabled')).toBe(false);
      expect(container.textContent).toContain('Incoming transcription · Not ready');
    } finally { await act(async () => { root.unmount(); }); }
  }));

  test('stale provider checks cannot repaint a panel after close and reopen', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
    const check = deferred<{ stt: { ready: boolean; code: string | null }; tts: { ready: boolean; code: string | null } }>();
    const api: BotsApi = { ...botsApi, getSpeechStatus: async () => status, checkSpeech: async () => check.promise };
    try {
      await act(async () => { root.render(<BotSpeechSettings botId="bot" active api={api} />); });
      await act(async () => { container.find((node) => node.tagName === 'DETAILS')?.toggle(true); });
      await act(async () => { container.find((node) => node.tagName === 'BUTTON' && node.textContent === 'Check Saved Providers')?.click(); });
      await act(async () => { container.find((node) => node.tagName === 'DETAILS')?.toggle(false); });
      await act(async () => { container.find((node) => node.tagName === 'DETAILS')?.toggle(true); });
      await act(async () => { check.resolve({ stt: { ready: true, code: null }, tts: { ready: true, code: null } }); });
      expect(container.textContent).not.toContain('Transcription: ready');
    } finally { await act(async () => { root.unmount(); }); }
  }));

  test('duplicate submits produce one save and clear an obsolete provider check', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element); let saves = 0;
    const save = deferred<BotSpeechStatus>();
    const api: BotsApi = { ...botsApi, getSpeechStatus: async () => status, checkSpeech: async () => ({ stt: { ready: true, code: null }, tts: { ready: false, code: 'not_configured' } }), configureSpeech: async () => { saves += 1; return save.promise; } };
    try {
      await act(async () => { root.render(<BotSpeechSettings botId="bot" active api={api} />); });
      await act(async () => { container.find((node) => node.tagName === 'DETAILS')?.toggle(true); });
      await act(async () => { container.find((node) => node.tagName === 'BUTTON' && node.textContent === 'Check Saved Providers')?.click(); });
      expect(container.textContent).toContain('Transcription: ready');
      await act(async () => { const form = container.find((node) => node.tagName === 'FORM'); form?.submit(); form?.submit(); });
      expect(saves).toBe(1); expect(container.textContent).not.toContain('Transcription: ready');
      await act(async () => { save.resolve(status); });
      expect(container.find((node) => node.tagName === 'FIELDSET')?.hasAttribute('disabled')).toBe(false);
    } finally { await act(async () => { root.unmount(); }); }
  }));
  test('a save completing after close and reopen refreshes the current form from the server', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
    const save = deferred<BotSpeechStatus>(); let saved = status; let loads = 0;
    const api: BotsApi = { ...botsApi, getSpeechStatus: async () => { loads += 1; return saved; }, configureSpeech: async () => save.promise };
    try {
      await act(async () => { root.render(<BotSpeechSettings botId="bot" active api={api} />); });
      await act(async () => { container.find((node) => node.tagName === 'DETAILS')?.toggle(true); });
      await act(async () => { container.find((node) => node.tagName === 'FORM')?.submit(); });
      await act(async () => { container.find((node) => node.tagName === 'DETAILS')?.toggle(false); });
      await act(async () => { container.find((node) => node.tagName === 'DETAILS')?.toggle(true); });
      await act(async () => { saved = { ...status, stt: { ...status.stt!, baseUrl: 'https://new.example/v1' } }; save.resolve(saved); });
      expect(loads).toBe(3); expect(container.find((node) => node.tagName === 'INPUT' && node.type === 'url')?.value).toBe('https://new.example/v1');
    } finally { await act(async () => { root.unmount(); }); }
  }));
});
