import React, { act } from 'react';
import { describe, expect, test } from 'bun:test';
import { botsApi, type BotTelegramStatus, type BotsApi } from '@/lib/botsApi';
import { getAuthPrincipal, setAuthPrincipal } from '@/lib/authSession';
import { withDom } from '@/components/bots/chat/botMountedDom';
import { BotTelegramConnection } from './BotTelegramConnection';

const base: BotTelegramStatus = { enabled: true, configured: true, state: 'connected', hostOnline: true, executionReady: true, pairing: null, preferences: { routineDelivery: false, voiceReplies: true }, deliveries: [] };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
const link = { pairingId: 'pairing', url: 'https://t.me/test_bot?start=private-once', expiresAt: '2026-08-31T12:00:00Z' };

describe('mounted Bot Telegram settings', () => {
  test('hiding then reopening discards a pairing link from the previous visible request', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
    const pending = deferred<typeof link>();
    const api: BotsApi = { ...botsApi, getTelegramStatus: async () => base, createTelegramPairing: async () => pending.promise };
    const render = (active: boolean) => root.render(<BotTelegramConnection botId="bot" canManage={false} active={active} api={api} />);
    try {
      await act(async () => { render(true); });
      expect(container.textContent).toContain('Host: online');
      await act(async () => { container.find((node) => node.tagName === 'BUTTON' && node.textContent === 'Create Pairing Link')?.click(); });
      await act(async () => { render(false); }); await act(async () => { render(true); });
      await act(async () => { pending.resolve(link); });
      expect(container.find((node) => node.tagName === 'A' && node.getAttribute('href') === link.url)).toBeNull();
    } finally { await act(async () => { root.unmount(); }); }
  }));

  test('an account switch cannot display the former member pairing response', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
    const original = getAuthPrincipal(); const pending = deferred<typeof link>();
    const api: BotsApi = { ...botsApi, getTelegramStatus: async () => base, createTelegramPairing: async () => pending.promise };
    try {
      await act(async () => { root.render(<BotTelegramConnection botId="bot" canManage={false} active api={api} />); });
      await act(async () => { container.find((node) => node.tagName === 'BUTTON' && node.textContent === 'Create Pairing Link')?.click(); });
      await act(async () => { setAuthPrincipal({ ...original, id: 'another-member' }); });
      await act(async () => { pending.resolve(link); });
      expect(container.find((node) => node.getAttribute('href') === link.url)).toBeNull();
    } finally { await act(async () => { root.unmount(); }); setAuthPrincipal(original); }
  }));

  test('a stale status refresh cannot replace a newly confirmed pairing', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
    const waiting = deferred<BotTelegramStatus>(); let loads = 0;
    const claimed: BotTelegramStatus = { ...base, pairing: { id: 'pairing', state: 'claimed', telegramUserId: '123', displayName: 'My account', expiresAt: link.expiresAt, confirmedAt: null } };
    const confirmed: BotTelegramStatus = { ...claimed, pairing: { ...claimed.pairing!, state: 'confirmed', confirmedAt: '2026-08-31T11:00:00Z' } };
    const api: BotsApi = { ...botsApi, getTelegramStatus: async () => { loads += 1; return loads === 1 ? claimed : loads === 2 ? waiting.promise : confirmed; }, confirmTelegramPairing: async () => confirmed };
    try {
      await act(async () => { root.render(<BotTelegramConnection botId="bot" canManage={false} active api={api} />); });
      await act(async () => { container.find((node) => node.tagName === 'BUTTON' && node.textContent === 'Refresh')?.click(); });
      await act(async () => { container.find((node) => node.tagName === 'BUTTON' && node.textContent === 'Confirm My Account')?.click(); });
      await act(async () => { waiting.resolve(claimed); });
      expect(container.textContent).toContain('Linked numeric Telegram ID: 123');
      expect(container.textContent).not.toContain('Confirm this is your account');
    } finally { await act(async () => { root.unmount(); }); }
  }));

  test('manager token remains write-only and ordinary members do not see configuration controls', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
    const api: BotsApi = { ...botsApi, getTelegramStatus: async () => ({ ...base, enabled: false }), getSpeechStatus: async () => { throw new Error('closed speech panel must not load'); } };
    try {
      await act(async () => { root.render(<BotTelegramConnection botId="bot" canManage active api={api} />); });
      const token = container.find((node) => node.tagName === 'INPUT' && node.type === 'password');
      expect(token).not.toBeNull(); expect(token?.value).toBe('');
      expect(container.textContent).toContain('Saving connection changes invalidates pending work');
      await act(async () => { root.render(<BotTelegramConnection botId="bot" canManage={false} active api={api} />); });
      expect(container.find((node) => node.tagName === 'INPUT' && node.type === 'password')).toBeNull();
      expect(container.textContent).not.toContain('Save Telegram');
    } finally { await act(async () => { root.unmount(); }); }
  }));

  test('uncertain delivery retry warns of duplicate parts and incoming errors never offer delivery replay', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
    let retries = 0;
    const status: BotTelegramStatus = { ...base, deliveries: [
      { id: 'delivery', state: 'uncertain', errorCode: 'telegram_delivery_uncertain', kind: 'result', partIndex: 1, createdAt: '', updatedAt: '' },
      { id: 'incoming', state: 'admission_uncertain', errorCode: 'telegram_admission_uncertain', kind: 'incoming', partIndex: 0, createdAt: '', updatedAt: '' },
    ] };
    const api: BotsApi = { ...botsApi, getTelegramStatus: async () => status, retryTelegramDelivery: async (_bot, id) => { expect(id).toBe('delivery'); retries += 1; return { retryQueued: true, mayDuplicateLastPart: true }; } };
    try {
      await act(async () => { root.render(<BotTelegramConnection botId="bot" canManage={false} active api={api} />); });
      expect(container.textContent).toContain('Retrying delivery never reruns the Bot');
      await act(async () => { container.find((node) => node.tagName === 'BUTTON' && node.textContent === 'Retry (May Duplicate)')?.click(); });
      expect(retries).toBe(1); expect(container.textContent).toContain('the last part may appear twice');
      expect(container.find((node) => node.tagName === 'BUTTON' && node.textContent === 'Retry Delivery')).toBeNull();
    } finally { await act(async () => { root.unmount(); }); }
  }));

  test('a manager without membership can configure but cannot start personal pairing', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
    const api: BotsApi = { ...botsApi, getTelegramStatus: async () => ({ ...base, canPair: false }) };
    try {
      await act(async () => { root.render(<BotTelegramConnection botId="bot" canManage active api={api} />); });
      expect(container.textContent).toContain('Save Telegram');
      expect(container.textContent).toContain('Active Bot membership is required');
      expect(container.find((node) => node.tagName === 'BUTTON' && node.textContent === 'Create Pairing Link')).toBeNull();
      expect(container.textContent).not.toContain('Your Telegram account');
    } finally { await act(async () => { root.unmount(); }); }
  }));
});
