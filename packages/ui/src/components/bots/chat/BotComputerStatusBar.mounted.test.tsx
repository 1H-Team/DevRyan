import React, { act } from 'react';
import { describe, expect, test } from 'bun:test';
import { I18nProvider } from '@/lib/i18n';
import type { BotSummary } from '@/lib/botsApi';
import { useBotsStore } from '@/stores/useBotsStore';
import { useBotComputerActivityStore } from '@/stores/useBotComputerActivityStore';
import { useBotOperationsStore } from '@/stores/useBotOperationsStore';
import { BotComputerStatusBar } from './BotComputerStatusBar';
import { withDom } from './botMountedDom';

const bot: BotSummary = { id: 'bot', name: 'Rockbot', title: '', summary: '', avatarUrl: null, avatarFallback: 'R', lifecycle: 'active', tenancy: 'team', activeRevisionId: 'revision', createdAt: '', updatedAt: '', retiredAt: null };

describe('Bot computer composer controls', () => {
  test('only opens on request, tracks active/waiting/idle, and clears on revocation', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    const activity = { botId: bot.id, channelId: 'channel', runId: 'run', revision: 1, state: 'active' as const };
    useBotComputerActivityStore.getState().reset();
    useBotsStore.getState().resetPrincipal('member');
    useBotOperationsStore.getState().resetPrincipal('member');
    useBotsStore.getState().upsertBot(bot);
    useBotsStore.getState().upsertMembership({ botId: bot.id, userId: 'member', role: 'operator', activatedAt: '', revokedAt: null, updatedAt: '' });
    try {
      await act(async () => { root.render(<I18nProvider><BotComputerStatusBar bot={bot} channelId="channel" /></I18nProvider>); });
      expect(container.textContent).toBe('');
      await act(async () => { useBotComputerActivityStore.getState().upsert({ ...activity, channelId: 'other' }); });
      expect(container.textContent).toBe('');
      await act(async () => { useBotComputerActivityStore.getState().upsert({ ...activity, revision: 2 }); });
      expect(container.textContent).toContain('Rockbot is using the computer');
      expect(useBotComputerActivityStore.getState().manualByBotId).toEqual({});
      const show = container.find((node) => node.tagName === 'BUTTON');
      expect(show?.textContent).toBe('Show');
      await act(async () => { show?.click(); });
      expect(useBotComputerActivityStore.getState().manualByBotId[bot.id]?.channelId).toBe('channel');
      expect(show?.textContent).toBe('Hide');
      await act(async () => { useBotComputerActivityStore.getState().upsert({ ...activity, state: 'waiting', revision: 3 }); });
      expect(container.textContent).toContain('Rockbot is waiting for computer control');
      await act(async () => { show?.click(); });
      expect(useBotComputerActivityStore.getState().manualByBotId).toEqual({});
      await act(async () => { useBotComputerActivityStore.getState().upsert({ ...activity, state: 'idle', revision: 4 }); });
      expect(container.textContent).toBe('');
      await act(async () => { useBotComputerActivityStore.getState().upsert({ ...activity, revision: 5 }); });
      expect(container.textContent).toContain('Rockbot is using');
      await act(async () => { useBotComputerActivityStore.getState().replace([]); });
      expect(container.textContent).toBe('');
      await act(async () => { useBotComputerActivityStore.getState().show(bot.id, 'channel'); });
      expect(container.textContent).toContain('Shared computer');
      await act(async () => { useBotsStore.getState().removeBot(bot.id); });
      expect(container.textContent).toBe('');
    } finally {
      await act(async () => { root.unmount(); });
      useBotComputerActivityStore.getState().reset();
      useBotsStore.getState().resetPrincipal(null);
      useBotOperationsStore.getState().resetPrincipal(null);
    }
  }));
});
