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
    })).toEqual({ active: true, ownedByViewer: false, actorLabel: 'another operator', expiresInSeconds: 3 });
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

  test('mounts only the server-issued ephemeral stream and waits for its first frame', async () => {
    const status: BotComputerStatus = {
      botId: BOT_ID,
      browser: {
        running: true,
        healthy: true,
        lifecycleState: 'running',
        generation: 1,
        mode: 'headed_virtual',
        engineVersion: 'Chromium/151.0',
        displayReady: true,
        webCapabilities: {
          managedPolicy: 'enforced',
          javascript: 'enabled',
          firstPartyCookies: 'enabled',
          thirdPartyCookies: 'enabled',
        },
        lastNavigationDiagnostic: {
          revision: 2,
          observedAt: Date.now(),
          origin: null,
          statusCode: 403,
          redirectCount: 0,
          repetitionCount: 0,
          kind: 'egress_denied',
          reason: 'egress_policy_denied',
          blockedHost: 'challenge.example',
        },
      },
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
    expect(markup).toContain('data-bot-computer-canvas="true"');
    expect(markup).toContain('data-bot-screen-view-state="connecting"');
    expect(markup).toContain('Connecting to the Bot desktop');
    expect(markup).toContain('opacity-0');
    expect(markup).toContain('another operator has control');
    expect(markup).toContain('Agent input is paused');
    expect(markup).toContain('data-bot-browser-warning="egress-denied"');
    expect(markup).toContain('does not allow challenge.example');
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

  test('a residual cookie diagnostic never outranks a real browser failure', async () => {
    const status: BotComputerStatus = {
      botId: BOT_ID,
      browser: {
        running: true,
        healthy: false,
        lifecycleState: 'running',
        generation: 1,
        mode: 'headed_virtual',
        engineVersion: 'Chromium/151.0',
        displayReady: true,
        webCapabilities: {
          managedPolicy: 'enforced',
          javascript: 'enabled',
          firstPartyCookies: 'enabled',
          thirdPartyCookies: 'enabled',
        },
        lastNavigationDiagnostic: {
          revision: 3,
          observedAt: Date.now(),
          origin: 'https://challenge.example',
          statusCode: null,
          redirectCount: 0,
          repetitionCount: 0,
          kind: 'blocked_cookies',
          reason: 'cookie_UserPreferences',
          blockedHost: null,
        },
      },
      control: null,
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
    expect(markup).toContain('data-bot-browser-warning="browser-failure"');
    expect(markup).not.toContain('data-bot-browser-warning="blocked-cookies"');
  });

  test('shows loop paths, browser prerequisites, handled dialogs, and popup state at the right severity', async () => {
    const diagnostic = {
      revision: 9,
      observedAt: Date.now(),
      origin: 'https://example.com',
      statusCode: 200,
      redirectCount: 1,
      repetitionCount: 3,
      kind: 'site_rejection' as const,
      reason: 'navigation_loop',
      blockedHost: null,
      trail: [
        { kind: 'navigation' as const, origin: 'https://example.com', path: '/login', observedAt: 1, statusCode: 200, redirectCount: 0 },
        { kind: 'navigation' as const, origin: 'https://example.com', path: '/app', observedAt: 2, statusCode: 302, redirectCount: 1 },
        { kind: 'navigation' as const, origin: 'https://example.com', path: '/login', observedAt: 3, statusCode: 200, redirectCount: 1 },
      ],
      dialogs: [{ kind: 'dialog' as const, origin: 'https://example.com', path: '/login', observedAt: 4, type: 'confirm' as const, message: 'Continue?' }],
    };
    const baseStatus: BotComputerStatus = {
      botId: BOT_ID,
      browser: {
        running: true,
        healthy: true,
        lifecycleState: 'running',
        popupOpen: true,
        webCapabilities: {
          managedPolicy: 'enforced',
          javascript: 'enabled',
          firstPartyCookies: 'enabled',
          thirdPartyCookies: 'enabled',
        },
        lastNavigationDiagnostic: diagnostic,
      },
      control: null,
      screencast: { subscribers: 1, lastFrameAt: 1, retainedFrames: 0 },
      framesRecorded: false,
      arbitraryWebsiteExactlyOnce: false,
    };
    const renderStatus = async (status: BotComputerStatus) => {
      const api = {
        startComputerView: async () => ({ view: {
          id: 'view_loop', botId: BOT_ID, channelId: CHANNEL_ID,
          streamUrl: `/api/bots/${BOT_ID}/computer/view/view_loop/stream`, startedAt: '',
        } }),
        stopComputerView: async () => ({ stopped: true }),
      } as unknown as BotsApi;
      const operationsStore = createBotOperationsStore({ api });
      operationsStore.getState().resetPrincipal(VIEWER_ID);
      operationsStore.getState().replaceSnapshot({ runs: [], pendingApprovals: [], computers: [status] });
      await operationsStore.getState().startComputerView(BOT_ID, CHANNEL_ID);
      Object.assign(operationsStore.getInitialState(), operationsStore.getState());
      return renderToStaticMarkup(
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
    };

    const agentMarkup = await renderStatus(baseStatus);
    expect(agentMarkup).toContain('data-bot-browser-warning="site-rejection" role="alert"');
    expect(agentMarkup).toContain('/login → /app');
    expect(agentMarkup).toContain('3 times in a row');
    expect(agentMarkup).toContain('Browser prerequisites: managed policy enforced');
    expect(agentMarkup).toContain('data-bot-browser-dialog="confirm"');
    expect(agentMarkup).toContain('Continue?');
    expect(agentMarkup).toContain('data-bot-browser-popup="open"');

    const viewerMarkup = await renderStatus({
      ...baseStatus,
      control: {
        leaseId: 'lease', actorId: VIEWER_ID, actorType: 'user',
        takenAt: Date.now(), expiresAt: Date.now() + 60_000,
      },
    });
    expect(viewerMarkup).toContain('data-bot-browser-warning="site-rejection" role="status"');
  });

  test('keeps screen pixels out of every Zustand store', () => {
    const source = readFileSync(resolve(testDir, 'BotBrowserDiagnostic.tsx'), 'utf8');
    const canvas = readFileSync(resolve(testDir, 'BotComputerCanvas.tsx'), 'utf8');
    const operationStore = readFileSync(resolve(testDir, '../../../stores/useBotOperationsStore.ts'), 'utf8');

    expect(source).toContain('<BotComputerCanvas');
    expect(source).toContain('const FIRST_FRAME_TIMEOUT_MS = 5_000;');
    expect(source).toContain('const COMPUTER_STATUS_POLL_MS = 2_000;');
    expect(source).toContain('refreshComputerDiagnostic(botId)');
    expect(canvas).toContain('fetch(view.streamUrl');
    expect(canvas).toContain('createImageBitmap');
    expect(canvas).toContain("new BotMjpegParser(botMjpegBoundary(response.headers.get('content-type')))");
    expect(canvas).toContain('bitmap?.close();');
    expect(canvas).toContain('inputDispatchingRef.current');
    expect(canvas).toContain('queueBotHumanInputEvent(batch, event, INPUT_BACKLOG_LIMIT)');
    expect(canvas).not.toContain('sendChainRef');
    expect(canvas).toContain('setKeyboardNavigationReleased(true);');
    expect(canvas).toContain('tabIndex={inputEnabled && !keyboardNavigationReleased ? 0 : -1}');
    expect(source).toContain('if (operationsStore.getState().computerViewsByBotId[botId]?.id !== expectedViewId) return;');
    expect(source).toContain('if (!active || !botActive || view || viewPending || viewErrorCode');
    expect(source).toContain('|| streamFailed || autoStartSuppressed) return;');
    expect(source).toContain('startComputerView(botId, channelId, runId)');
    expect(source).toContain('stopComputerView(botId)');
    expect(operationStore).not.toContain('frameData');
    expect(operationStore).not.toContain('canvas');
  });
});
