import React from 'react';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import type { BotComputerStatus, BotsApi } from '@/lib/botsApi';
import { createBotOperationsStore } from '@/stores/useBotOperationsStore';
import { resolveBotControlPresentation } from '../botPresentation';
import { BotBrowserDiagnostic } from './BotBrowserDiagnostic';

const testDir = dirname(fileURLToPath(import.meta.url));
const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const CHANNEL_ID = 'c0000000-0000-4000-8000-000000000001';
const VIEWER_ID = 'a0000000-0000-4000-8000-000000000001';
const CONTROLLER_ID = 'a0000000-0000-4000-8000-000000000002';
describe('BotBrowserDiagnostic', () => {
  test('expires stale leases locally and identifies the active human controller', () => {
    expect(resolveBotControlPresentation({
      control: { leaseId: 'lease', actorId: CONTROLLER_ID, actorType: 'admin', takenAt: 100, expiresAt: 999 },
      principalId: VIEWER_ID,
      now: 1_000,
    })).toEqual({ active: false, ownedByViewer: false, actorLabel: null, expiresInSeconds: null });

    expect(resolveBotControlPresentation({
      control: { leaseId: 'lease', actorId: CONTROLLER_ID, actorType: 'admin', takenAt: 100, expiresAt: 12_500 },
      principalId: VIEWER_ID,
      now: 10_000,
    })).toEqual({ active: true, ownedByViewer: false, actorLabel: 'admin a0000000', expiresInSeconds: 3 });
  });

  test('renders the safe shell without starting a stream during server rendering', () => {
    const requests: string[] = [];
    const api = {
      getComputerStatus: async () => { requests.push('status'); throw new Error('unexpected'); },
      startComputerView: async () => { requests.push('start'); throw new Error('unexpected'); },
      stopComputerView: async () => { requests.push('stop'); return { stopped: true }; },
    } as unknown as BotsApi;
    const operationsStore = createBotOperationsStore({ api });
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <BotBrowserDiagnostic
          botId={BOT_ID}
          channelId={CHANNEL_ID}
          botActive
          principalId={VIEWER_ID}
          canControl={false}
          active
          operationsStore={operationsStore}
        />
      </I18nProvider>,
    );

    expect(requests).toEqual([]);
    expect(markup).toContain('data-bot-screen-view-state="off"');
    expect(markup).toContain('Screen viewing is off');
    expect(markup).toContain('Start Screen Viewing');
    expect(markup).not.toContain('<img');
  });

  test('mounts only the server-issued ephemeral stream and keeps control separate', async () => {
    const status: BotComputerStatus = {
      botId: BOT_ID,
      browser: { url: 'https://example.com' },
      control: {
        leaseId: 'lease',
        actorId: CONTROLLER_ID,
        actorType: 'admin',
        takenAt: Date.now() - 1_000,
        expiresAt: Date.now() + 30_000,
      },
      screencast: { subscribers: 1, lastFrameAt: Date.now(), retainedFrames: 0 },
      framesRecorded: false,
      arbitraryWebsiteExactlyOnce: false,
    };
    const api = {
      startComputerView: async () => ({
        view: {
          id: 'view_opaque',
          botId: BOT_ID,
          channelId: CHANNEL_ID,
          streamUrl: `/api/bots/${BOT_ID}/computer/view/view_opaque/stream`,
          startedAt: '2026-08-25T00:00:00.000Z',
        },
      }),
      stopComputerView: async () => ({ stopped: true }),
    } as unknown as BotsApi;
    const operationsStore = createBotOperationsStore({ api });
    operationsStore.getState().resetPrincipal(VIEWER_ID);
    operationsStore.getState().replaceSnapshot({ runs: [], pendingApprovals: [], computers: [status] });
    await operationsStore.getState().startComputerView(BOT_ID, CHANNEL_ID);
    Object.assign(operationsStore.getInitialState(), operationsStore.getState());

    const markup = renderToStaticMarkup(
      <I18nProvider>
        <BotBrowserDiagnostic
          botId={BOT_ID}
          channelId={CHANNEL_ID}
          botActive
          principalId={VIEWER_ID}
          canControl
          active
          operationsStore={operationsStore}
        />
      </I18nProvider>,
    );
    expect(markup).toContain(`/computer/view/view_opaque/stream`);
    expect(markup).toContain('data-bot-screen-view-state="viewing"');
    expect(markup).toContain('admin a0000000 has control');
    expect(markup).toContain('Agent input is paused');
    expect(markup).toContain('Live diagnostic · frames are never recorded');
    expect(markup).toContain('Stop Screen Viewing');
    expect(markup).toContain('disabled=""');

    const memberMarkup = renderToStaticMarkup(
      <I18nProvider>
        <BotBrowserDiagnostic
          botId={BOT_ID}
          channelId={CHANNEL_ID}
          botActive
          principalId={VIEWER_ID}
          canControl={false}
          active
          operationsStore={operationsStore}
        />
      </I18nProvider>,
    );
    expect(memberMarkup).toContain('View only');
    expect(memberMarkup).not.toContain('Take Control');
    expect(memberMarkup).not.toContain('Return Control');
  });

  test('keeps screen pixels out of every Zustand store', () => {
    const source = readFileSync(resolve(testDir, 'BotBrowserDiagnostic.tsx'), 'utf8');
    const operationStore = readFileSync(resolve(testDir, '../../../stores/useBotOperationsStore.ts'), 'utf8');

    expect(source).toContain('<img');
    expect(source).toContain('src={visibleView.streamUrl}');
    expect(source).toContain('if (!active || !botActive || view || viewPending || viewErrorCode');
    expect(source).toContain('|| streamFailed || autoStartSuppressed) return;');
    expect(source).toContain('startComputerView(botId, channelId)');
    expect(source).toContain('stopComputerView(botId)');
    expect(operationStore).not.toContain('frameData');
    expect(operationStore).not.toContain('canvas');
  });
});
