import React from 'react';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import type { BotMembershipSummary, BotRun, BotSummary } from '@/lib/botsApi';
import { createBotChannelStore } from '@/stores/useBotChannelStore';
import { createBotOperationsStore } from '@/stores/useBotOperationsStore';
import { createBotsStore } from '@/stores/useBotsStore';
import { BotSidebarSection } from './BotSidebarSection';

const testDir = dirname(fileURLToPath(import.meta.url));
const USER_ID = 'a0000000-0000-4000-8000-000000000001';
const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const CHANNEL_ID = 'd0000000-0000-4000-8000-000000000001';

const bot: BotSummary = {
  id: BOT_ID,
  name: 'Release Steward',
  title: 'Release operations lead',
  summary: 'Coordinates release work.',
  avatarUrl: null,
  avatarFallback: 'RS',
  lifecycle: 'active',
  tenancy: 'team',
  activeRevisionId: 'c0000000-0000-4000-8000-000000000001',
  createdAt: '2026-08-23T00:00:00.000Z',
  updatedAt: '2026-08-23T00:00:00.000Z',
  retiredAt: null,
};
const membership: BotMembershipSummary = {
  botId: BOT_ID,
  userId: USER_ID,
  role: 'operator',
  activatedAt: '2026-08-23T00:00:00.000Z',
  revokedAt: null,
  updatedAt: '2026-08-23T00:00:00.000Z',
};

const makeStores = (botOverrides: Partial<BotSummary> = {}) => {
  const botsStore = createBotsStore();
  const channelStore = createBotChannelStore({ getPrincipalId: () => USER_ID });
  botsStore.getState().resetPrincipal(USER_ID);
  channelStore.getState().resetPrincipal(USER_ID);
  botsStore.getState().replaceSnapshot({
    bots: [{ ...bot, ...botOverrides }],
    revisions: [],
    memberships: [membership],
  });
  channelStore.getState().replaceSnapshot({
    channels: [{
      id: CHANNEL_ID,
      botId: BOT_ID,
      ownerUserId: USER_ID,
      accessRole: 'owner',
      canSend: true,
      lifecycle: 'active',
      currentCheckpointNumber: 0,
      lastMessageSequence: 1,
      lastMessageAt: '2026-08-23T00:00:00.000Z',
      createdAt: '2026-08-23T00:00:00.000Z',
      updatedAt: '2026-08-23T00:00:00.000Z',
      archivedAt: null,
    }],
    channelPreviews: [{
      channelId: CHANNEL_ID,
      messageId: 'e0000000-0000-4000-8000-000000000001',
      role: 'assistant',
      sequence: 1,
      text: '**Deploy completed**\nwithout errors.',
      attachmentCount: 0,
      createdAt: '2026-08-23T00:00:00.000Z',
      finalizedAt: '2026-08-23T00:00:00.000Z',
    }],
  });
  botsStore.getState().setCapabilities({
    available: true,
    state: 'healthy',
    code: null,
    owner: 'electron',
    canManageRuntime: true,
    canCreateBot: false,
  });
  Object.assign(botsStore.getInitialState(), botsStore.getState());
  Object.assign(channelStore.getInitialState(), channelStore.getState());
  return { botsStore, channelStore };
};

const renderAtWidth = (
  width: number,
  theme: 'light' | 'dark',
  selected = false,
  botOverrides: Partial<BotSummary> = {},
) => {
  const stores = makeStores(botOverrides);
  if (selected) {
    stores.botsStore.getState().selectBot(BOT_ID);
  }
  Object.assign(stores.botsStore.getInitialState(), stores.botsStore.getState());
  return renderToStaticMarkup(
    <I18nProvider>
      <div data-theme={theme} style={{ width }}>
        <BotSidebarSection  {...stores} />
      </div>
    </I18nProvider>,
  );
};

describe('BotSidebarSection', () => {
  test('stays width-agnostic at the supported 220, 280, and 500px sidebar widths', () => {
    for (const width of [220, 280, 500]) {
      const markup = renderAtWidth(width, width === 280 ? 'dark' : 'light');
      expect(markup).toContain(`width:${width}px`);
      expect(markup).toContain('Release Steward');
      expect(markup).toContain('Deploy completed without errors.');
      expect(markup).toContain('RS');
      expect(markup).toContain('min-h-[72px]');
      expect(markup).toContain('h-11 w-11');
      expect(markup).toContain('bg-[var(--status-success)]');
      expect(markup).not.toContain('Operator · Active');
      expect(markup).toContain('w-full min-w-0');
      expect(markup).not.toContain('min-width:280');
    }
  });

  test('renders the uploaded Bot avatar and retains the configured fallback when no image exists', () => {
    const avatarMarkup = renderAtWidth(280, 'dark', false, {
      avatarUrl: '/api/bots/release-steward/avatar',
    });
    const fallbackMarkup = renderAtWidth(280, 'dark');

    expect(avatarMarkup).toContain('src="/api/bots/release-steward/avatar"');
    expect(avatarMarkup).toContain('alt="Release operations lead avatar"');
    expect(fallbackMarkup).toContain('RS');
    expect(fallbackMarkup).not.toContain('<img');
  });

  test('uses native keyboard-focusable rows with current-page and visible focus semantics', () => {
    const markup = renderAtWidth(280, 'dark', true);

    expect(markup).toContain('<button');
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain('border-border bg-interactive-selection');
    expect(markup).toContain('focus-visible:ring-2');
    expect(markup).toContain('aria-label="Open Conversation with Release Steward. Deploy completed without errors. Aug 23"');
  });

  const renderWithRun = (state: BotRun['state'] | null) => {
    const stores = makeStores();
    const operationsStore = createBotOperationsStore();
    if (state) {
      operationsStore.getState().upsertRun({
        id: 'f0000000-0000-4000-8000-000000000001',
        botId: BOT_ID,
        channelId: CHANNEL_ID,
        revisionId: 'c0000000-0000-4000-8000-000000000001',
        modelSnapshot: null,
        computerScopeKey: `bot:${BOT_ID}`,
        queueSequence: 1,
        state,
        retryable: false,
        interruptionKind: null,
        createdAt: '2026-08-23T00:00:00.000Z',
        updatedAt: '2026-08-23T00:00:00.000Z',
        startedAt: null,
        finishedAt: null,
      });
    }
    Object.assign(operationsStore.getInitialState(), operationsStore.getState());
    return renderToStaticMarkup(
      <I18nProvider>
        <BotSidebarSection  {...stores} operationsStore={operationsStore} />
      </I18nProvider>,
    );
  };

  test('shows typing dots while the Bot is preparing or writing, even from another channel', () => {
    for (const state of ['queued', 'starting', 'running'] as const) {
      const markup = renderWithRun(state);
      expect(markup).toContain('data-bot-sidebar-status="typing"');
      expect(markup).toContain('animate-bot-typing-dot');
      expect(markup).toContain('Typing…');
      expect(markup).not.toContain('Deploy completed without errors.');
      expect(markup).toContain('aria-label="Open Conversation with Release Steward. Typing. Aug 23"');
    }
  });

  test('says the Bot needs the member while a run waits on them, and shows the preview otherwise', () => {
    for (const state of ['waiting_approval', 'waiting_control', 'needs_reconciliation'] as const) {
      const markup = renderWithRun(state);
      expect(markup).toContain('data-bot-sidebar-status="waiting"');
      expect(markup).toContain('Needs you');
      expect(markup).not.toContain('animate-bot-typing-dot');
    }
    for (const state of ['completed', 'failed', null] as const) {
      const markup = renderWithRun(state);
      expect(markup).not.toContain('data-bot-sidebar-status');
      expect(markup).toContain('Deploy completed without errors.');
    }
  });

  test('keeps Bot selection outside ordinary session nodes without clearing the coding session', () => {
    const source = readFileSync(resolve(testDir, 'BotSidebarSection.tsx'), 'utf8');
    const sidebar = readFileSync(resolve(testDir, '../../session/SessionSidebar.tsx'), 'utf8');
    const sessionNode = readFileSync(resolve(testDir, '../../session/sidebar/SessionNodeItem.tsx'), 'utf8');

    expect(source).not.toContain('setCurrentSession(null)');
    expect(source).not.toContain("setActiveMainTab('chat')");
    expect(source).toContain("setAudience('bots')");
    expect(source).toContain('ensureOwnerChannel(botId)');
    expect(sidebar).toContain("audience === 'bots'");
    expect(sidebar).toContain("audience === 'coding-agents'");
    expect(sidebar).toContain('role="tabpanel"');
    expect(sessionNode).not.toContain('BotSidebar');
    expect(sessionNode).not.toContain('useBotsStore');
  });
});
