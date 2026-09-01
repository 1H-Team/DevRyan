import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { BotLifecycleActions } from './BotLifecycleActions';
import { botLifecycleAllowsDispatch } from './botManagementPresentation';
import { managementDetail } from './botManagementTestFixtures';

describe('BotLifecycleActions', () => {
  test('blocks send and routine dispatch outside Active', () => {
    expect(botLifecycleAllowsDispatch('active')).toBe(true);
    expect(botLifecycleAllowsDispatch('draft')).toBe(false);
    expect(botLifecycleAllowsDispatch('paused')).toBe(false);
    expect(botLifecycleAllowsDispatch('retired')).toBe(false);
  });

  test('shows only Active, Paused, and one complete delete action', () => {
    const detail = managementDetail();
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <BotLifecycleActions
          bot={detail.bot}
          hasChatHistory
          onTransition={() => {}}
          onClearChatHistory={() => {}}
          onDeleteCompletely={() => {}}
        />
      </I18nProvider>,
    );
    for (const label of ['Lifecycle', 'Current state', 'Active', 'Pause', 'Chat history', 'Clear History', 'Delete Bot']) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain('Shared learning remains available to the Bot.');
    for (const removed of ['Retire', 'Granular purge', 'Preview Purge', 'Delete Bot Completely']) {
      expect(markup).not.toContain(removed);
    }
  });

  test('presents an unpublished lifecycle as Setup Incomplete instead of Draft', () => {
    const detail = managementDetail();
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <BotLifecycleActions
          bot={{ ...detail.bot, lifecycle: 'draft', activeRevisionId: null }}
          onTransition={() => {}}
        />
      </I18nProvider>,
    );
    expect(markup).toContain('Setup incomplete');
    expect(markup).not.toContain('>draft · personalized<');
    expect(markup).toContain('Delete Bot');
    expect(markup).not.toContain('Retire');
  });

  test('allows complete deletion without a retired intermediate state', () => {
    const detail = managementDetail();
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <BotLifecycleActions
          bot={{ ...detail.bot, lifecycle: 'active' }}
          onTransition={() => {}}
        />
      </I18nProvider>,
    );

    expect(markup).toContain('Delete Bot');
    expect(markup).not.toContain('Retire');
    expect(markup).not.toContain('Preview Purge');
  });

  test('keeps partial purge failures visible and retryable', () => {
    const detail = managementDetail();
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <BotLifecycleActions
          bot={detail.bot}
          purgeResult={{
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            botId: detail.bot.id,
            botName: detail.bot.name,
            state: 'partial',
            complete: false,
            retryable: true,
            botDeleted: false,
            selectedResourceIds: ['browser_profiles'],
            steps: [{
              id: 'browser_profiles',
              status: 'failed',
              attempts: 1,
              detail: 'Docker unavailable',
              code: 'bot_runtime_docker_unavailable',
              completedAt: null,
            }],
            createdAt: '2026-08-23T12:00:00.000Z',
            updatedAt: '2026-08-23T12:01:00.000Z',
            completedAt: null,
          }}
          onTransition={() => {}}
          onRetryPurge={() => {}}
        />
      </I18nProvider>,
    );
    expect(markup).toContain('Deletion needs cleanup');
    expect(markup).toContain('Some protected resources could not be removed.');
    expect(markup).toContain('Retry Cleanup');
  });
});
