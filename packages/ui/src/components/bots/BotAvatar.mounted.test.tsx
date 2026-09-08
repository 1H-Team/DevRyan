import React, { act } from 'react';
import { describe, expect, spyOn, test } from 'bun:test';
import { botAvatarCache, createBotAvatarCache } from '@/lib/botAvatarCache';
import { useBotsStore } from '@/stores/useBotsStore';
import { managementDetail } from '../sections/bots/botManagementTestFixtures';
import { BotAvatar } from './BotAvatar';
import { withDom } from './chat/botMountedDom';

const bot = (id: string) => ({ ...managementDetail().bot, id, name: id.toUpperCase(), avatarFallback: null, avatarUrl: `/api/bots/${id}/avatar?v=1` });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe('mounted Bot avatar identity', () => {
  test('A → B → A never retains the previous image, and warm selection renders synchronously', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    const pending = new Map<string, (image: { url: string; bytes: number; dispose(): void }) => void>();
    const cache = createBotAvatarCache({ load: (id) => new Promise((resolve) => pending.set(id.botId, resolve)) });
    const subscribe = spyOn(botAvatarCache, 'subscribe').mockImplementation(cache.subscribe);
    const peek = spyOn(botAvatarCache, 'peek').mockImplementation(cache.peek);
    const render = (id: string) => root.render(<BotAvatar bot={bot(id)} />);
    try {
      await act(async () => { render('a'); await flush(); });
      expect(container.textContent).toBe('A');
      await act(async () => { pending.get('a')?.({ url: 'blob:a', bytes: 10, dispose() {} }); await flush(); });
      const imageA = container.find((node) => node.nodeName === 'IMG');
      expect(imageA?.getAttribute('src')).toBe('blob:a');
      await act(async () => { render('b'); await flush(); });
      expect(container.textContent).toBe('B');
      expect(container.find((node) => node.nodeName === 'IMG')).toBeNull();
      await act(async () => { render('a'); });
      expect(container.find((node) => node.nodeName === 'IMG')?.getAttribute('src')).toBe('blob:a');
      await act(async () => { pending.get('b')?.({ url: 'blob:b', bytes: 10, dispose() {} }); await flush(); });
      expect(container.find((node) => node.nodeName === 'IMG')?.getAttribute('src')).toBe('blob:a');
      await act(async () => { render('b'); });
      expect(container.find((node) => node.nodeName === 'IMG')?.getAttribute('src')).toBe('blob:b');
      expect(container.find((node) => node.nodeName === 'IMG')).not.toBe(imageA);
    } finally {
      await act(async () => root.unmount()); subscribe.mockRestore(); peek.mockRestore(); cache.clear();
    }
  }));

  test('a failed old bot does not suppress the next bot image', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    const cache = createBotAvatarCache({ load: async (id) => {
      if (id.botId === 'a') throw new Error('unavailable');
      return { url: 'blob:b', bytes: 10, dispose() {} };
    } });
    const subscribe = spyOn(botAvatarCache, 'subscribe').mockImplementation(cache.subscribe);
    const peek = spyOn(botAvatarCache, 'peek').mockImplementation(cache.peek);
    try {
      await act(async () => { root.render(<BotAvatar bot={bot('a')} />); await flush(); });
      expect(container.textContent).toBe('A');
      await act(async () => { root.render(<BotAvatar bot={bot('b')} />); await flush(); });
      expect(container.find((node) => node.nodeName === 'IMG')?.getAttribute('src')).toBe('blob:b');
    } finally {
      await act(async () => root.unmount()); subscribe.mockRestore(); peek.mockRestore(); cache.clear();
    }
  }));

  test('catalog mutations invalidate only changed identities and auth resets clear all', () => {
    useBotsStore.getState().resetPrincipal('avatar-test');
    const invalidate = spyOn(botAvatarCache, 'invalidateBot');
    const clear = spyOn(botAvatarCache, 'clear');
    try {
      useBotsStore.getState().upsertBot(bot('a'));
      useBotsStore.getState().upsertBot({ ...bot('a'), updatedAt: 'later', title: 'Renamed' });
      expect(invalidate).toHaveBeenCalledTimes(0);
      useBotsStore.getState().upsertBot({ ...bot('a'), avatarUrl: '/avatar?v=2' });
      expect(invalidate).toHaveBeenCalledWith('a');
      useBotsStore.getState().upsertMembership({ botId: 'a', userId: 'avatar-test', role: 'member', activatedAt: '', revokedAt: null, updatedAt: '' });
      useBotsStore.getState().removeMembership('a');
      expect(invalidate).toHaveBeenCalledWith('a');
      useBotsStore.getState().removeBot('a');
      expect(invalidate).toHaveBeenCalledWith('a');
      expect(invalidate).toHaveBeenCalledTimes(3);
      useBotsStore.getState().resetPrincipal('another-principal');
      expect(clear).toHaveBeenCalledTimes(1);
    } finally { invalidate.mockRestore(); clear.mockRestore(); useBotsStore.getState().resetPrincipal(null); }
  });
});
