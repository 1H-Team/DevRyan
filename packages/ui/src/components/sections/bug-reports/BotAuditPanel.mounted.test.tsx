import React, { act } from 'react';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import { withDom } from '@/components/bots/chat/botMountedDom';
import { I18nProvider } from '@/lib/i18n';

import { BotAuditPanel } from './BotAuditPanel';
import type { BotAuditDetail, BotAuditSummary } from './types';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const RESOLUTION_ID = '22222222-2222-4222-8222-222222222222';
const summary: BotAuditSummary = {
  eventId: EVENT_ID,
  action: 'bot.computer.navigation_loop',
  result: 'failure',
  timestamp: '2026-09-02T10:00:00.000Z',
  summary: 'Browser navigation loop detected',
  diagnosticCode: 'DEVRYAN_BOT_BROWSER_NAVIGATION_LOOP',
  bot: {
    id: '33333333-3333-4333-8333-333333333333',
    name: 'Research Bot',
    title: null,
    lifecycle: 'active',
    deleted: false,
  },
  actor: {
    id: null,
    displayName: 'System',
    email: '',
    role: null,
    former: false,
  },
  target: { type: 'bot_computer', id: 'computer-01' },
  resolvedAt: '2026-09-02T10:02:00.000Z',
  resolvedByEventId: RESOLUTION_ID,
};
const detail: BotAuditDetail = {
  ...summary,
  metadata: { generation: 2, revision: 8 },
  metadataRedacted: false,
};

afterEach(() => {
  spyOn(globalThis, 'fetch').mockRestore();
});

describe('mounted Bot audit panel', () => {
  test('pins a stable query bound and exposes generalized resolution in list and detail views', async () => withDom(async (container) => {
    const requests: string[] = [];
    spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      requests.push(url);
      if (url === '/api/bot-audit/options') return Response.json({ bots: [] });
      if (url === '/api/admin/users') return Response.json({ users: [] });
      if (url === `/api/bot-audit/${EVENT_ID}`) return Response.json({ log: detail });
      if (url.startsWith('/api/bot-audit?')) {
        return Response.json({ logs: [summary], nextCursor: null });
      }
      return Response.json({ error: 'Unexpected request' }, { status: 500 });
    });

    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => {
        root.render(<I18nProvider><BotAuditPanel /></I18nProvider>);
      });

      const listRequest = requests.find((url) => url.startsWith('/api/bot-audit?'));
      expect(listRequest).toContain('to=');
      expect(container.find((node) => node.hasAttribute('data-bot-audit-resolved'))).not.toBeNull();
      expect(container.textContent).toContain('Resolved');

      await act(async () => {
        container.find((node) => node.tagName === 'BUTTON' && node.textContent.includes(summary.summary))?.click();
      });

      expect(container.textContent).toContain('Resolved at');
      expect(container.textContent).toContain('Resolved by event ID');
      expect(container.textContent).toContain(RESOLUTION_ID);
    } finally {
      await act(async () => { root.unmount(); });
    }
  }));
});
