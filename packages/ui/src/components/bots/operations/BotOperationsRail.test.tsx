import React from 'react';
import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import type { BotActionAttempt, BotChannel, BotRun } from '@/lib/botsApi';
import { createBotChannelStore } from '@/stores/useBotChannelStore';
import { createBotOperationsStore } from '@/stores/useBotOperationsStore';
import { createBotsStore } from '@/stores/useBotsStore';
import { describeBotActionTarget } from '../botPresentation';
import { BotApprovalsTab } from './BotApprovalsTab';
import { BotCurrentRun } from './BotCurrentRun';
import { BotOperationsRail } from './BotOperationsRail';

const testDir = dirname(fileURLToPath(import.meta.url));
const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const OTHER_BOT_ID = 'b0000000-0000-4000-8000-000000000002';
const CHANNEL_ID = 'd0000000-0000-4000-8000-000000000001';
const RUN_ID = 'f0000000-0000-4000-8000-000000000001';
const ACTION_ID = 'a1000000-0000-4000-8000-000000000001';
const USER_ID = 'a0000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = 'a0000000-0000-4000-8000-000000000002';

const channel: BotChannel = {
  id: CHANNEL_ID,
  botId: BOT_ID,
  ownerUserId: USER_ID,
  accessRole: 'collaborator',
  canSend: true,
  lifecycle: 'active',
  currentCheckpointNumber: 0,
  lastMessageSequence: 0,
  lastMessageAt: null,
  createdAt: '2026-08-23T00:00:00.000Z',
  updatedAt: '2026-08-23T00:00:00.000Z',
  archivedAt: null,
};
const run: BotRun = {
  id: RUN_ID,
  botId: BOT_ID,
  channelId: CHANNEL_ID,
  revisionId: 'c0000000-0000-4000-8000-000000000001',
  modelSnapshot: null,
  computerScopeKey: 'scope',
  queueSequence: 3,
  state: 'waiting_approval',
  retryable: false,
  interruptionKind: null,
  createdAt: '2026-08-23T00:00:00.000Z',
  updatedAt: '2026-08-23T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
};
const action: BotActionAttempt = {
  id: ACTION_ID,
  runId: RUN_ID,
  botId: BOT_ID,
  revisionId: run.revisionId,
  credentialId: null,
  computerScopeKey: 'scope',
  actionHash: 'hash',
  argsDigest: 'digest',
  tool: 'browser',
  action: 'submit',
  target: { origin: 'https://example.com', goal: 'Submit release' },
  risk: 'sensitive',
  approvalClass: 'operator',
  policyEffect: 'prompt',
  policyRuleIds: ['rule'],
  decisionExpiresAt: '2099-08-23T00:00:00.000Z',
  requiresDistinctApprover: false,
  retainEvidence: true,
  state: 'pending_approval',
  unknownOutcome: false,
  reconciliationDecision: null,
  initiatedBy: USER_ID,
  createdAt: '2026-08-23T00:00:00.000Z',
  updatedAt: '2026-08-23T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
};

let botsStore = createBotsStore();
let channelStore = createBotChannelStore();
let operationsStore = createBotOperationsStore();

beforeEach(() => {
  botsStore = createBotsStore();
  channelStore = createBotChannelStore({ getPrincipalId: () => USER_ID });
  operationsStore = createBotOperationsStore();
  botsStore.getState().resetPrincipal(USER_ID);
  channelStore.getState().resetPrincipal(USER_ID);
  operationsStore.getState().resetPrincipal(USER_ID);
  botsStore.getState().replaceSnapshot({
    bots: [{
      id: BOT_ID,
      name: 'Release Steward',
      title: 'Release Steward',
      summary: 'Coordinates release work.',
      avatarUrl: null,
      avatarFallback: '🤖',
      lifecycle: 'active',
      tenancy: 'team',
      activeRevisionId: run.revisionId,
      createdAt: run.createdAt!,
      updatedAt: run.updatedAt!,
      retiredAt: null,
    }],
    revisions: [{
      id: run.revisionId,
      botId: BOT_ID,
      revisionNumber: 7,
      compiledHash: 'compiled',
      createdAt: run.createdAt!,
      activatedAt: run.createdAt,
      retiredAt: null,
    }],
    memberships: [{
      botId: BOT_ID,
      userId: USER_ID,
      role: 'manager',
      activatedAt: run.createdAt!,
      revokedAt: null,
      updatedAt: run.updatedAt!,
    }],
  });
  channelStore.getState().replaceSnapshot({ channels: [channel] });
  operationsStore.getState().replaceSnapshot({ runs: [run], pendingApprovals: [action], computers: [] });
  operationsStore.getState().setConnectionState('connected');
  Object.assign(botsStore.getInitialState(), botsStore.getState());
  Object.assign(channelStore.getInitialState(), channelStore.getState());
  Object.assign(operationsStore.getInitialState(), operationsStore.getState());
});

describe('BotOperationsRail', () => {
  test('uses accessible keyboard-managed tabs and remains fluid from 220 to 500px', () => {
    for (const width of [220, 280, 500]) {
      const markup = renderToStaticMarkup(
        <I18nProvider>
          <div data-theme={width === 280 ? 'dark' : 'light'} style={{ width }}>
            <BotOperationsRail
              botId={BOT_ID}
              channelId={CHANNEL_ID}
              botsStore={botsStore}
              channelStore={channelStore}
              operationsStore={operationsStore}
            />
          </div>
        </I18nProvider>,
      );
      expect(markup).toContain(`width:${width}px`);
      expect(markup).toContain('aria-label="Bot Operations Views"');
      expect(markup).toContain('@container');
      expect(markup).toContain('@min-[420px]:inline');
      expect(markup).toContain('aria-label="Live Computer"');
      expect(markup).not.toContain('aria-label="Activity"');
      expect(markup).toContain('aria-label="Confirmations"');
      expect(markup).toContain('aria-label="Shared"');
    }
  });

  test('shows only the current queued run with a compact cancel action', () => {
    operationsStore.getState().upsertRun({ ...run, state: 'queued' });
    Object.assign(operationsStore.getInitialState(), operationsStore.getState());
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <BotCurrentRun
          channelId={CHANNEL_ID}
          canCancel
          operationsStore={operationsStore}
        />
      </I18nProvider>,
    );

    expect(markup).toContain('Queued');
    expect(markup).not.toContain('Queue position');
    expect(markup).not.toContain('position 3');
    expect(markup).not.toContain('Revision 7');
    expect(markup).not.toContain('Tool activity');
    expect(markup).not.toContain('browser · submit');
    expect(markup).toContain('aria-label="Cancel Bot Run"');
  });

  test('keeps approval deep links and removes the activity panel implementation', () => {
    const railSource = readFileSync(resolve(testDir, './BotOperationsRail.tsx'), 'utf8');
    const approvalsSource = readFileSync(resolve(testDir, './BotApprovalsTab.tsx'), 'utf8');

    expect(railSource).not.toContain("activeTab === 'activity'");
    expect(railSource).not.toContain('BotQueueTab');
    expect(railSource).toContain("active={activeTab === 'approvals'}");
    expect(approvalsSource).toContain('if (!active || !focused || !rowRef.current) return;');
  });

  test('localizes connection state and exposes a sanitized reconnect error with Retry', () => {
    operationsStore.getState().setConnectionState(
      'reconnecting',
      'bot_event_connection_lost<script>',
    );
    Object.assign(operationsStore.getInitialState(), operationsStore.getState());
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <BotOperationsRail
          botId={BOT_ID}
          channelId={CHANNEL_ID}
          botsStore={botsStore}
          channelStore={channelStore}
          operationsStore={operationsStore}
        />
      </I18nProvider>,
    );

    expect(markup).toContain('Reconnecting');
    expect(markup).toContain('bot_event_connection_lostscript');
    expect(markup).not.toContain('&lt;script&gt;');
    expect(markup).toContain('Retry</button>');
  });

  test('keeps the persistent Live Computer available after a run completes', () => {
    operationsStore.getState().upsertRun({
      ...run,
      state: 'completed',
      finishedAt: '2026-08-23T00:02:00.000Z',
    });
    Object.assign(operationsStore.getInitialState(), operationsStore.getState());
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <BotOperationsRail
          botId={BOT_ID}
          channelId={CHANNEL_ID}
          botsStore={botsStore}
          channelStore={channelStore}
          operationsStore={operationsStore}
        />
      </I18nProvider>,
    );

    expect(markup).toContain('Open in Conversation');
    expect(markup).not.toContain(`data-bot-live-computer="${BOT_ID}"`);
    expect(markup).not.toContain('No live computer');
  });

  test('renders bounded approval identity and simple member decisions', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <BotApprovalsTab
          botId={BOT_ID}
          canOperate
          principalId={OTHER_USER_ID}
          operationsStore={operationsStore}
        />
      </I18nProvider>,
    );

    expect(describeBotActionTarget(action)).toBe('https://example.com');
    expect(markup).toContain('browser · submit');
    expect(markup).toContain('Sensitive');
    expect(markup).toContain('>Approve<');
    expect(markup).toContain('>Deny<');
    expect(markup).not.toContain(action.actionHash);
    expect(markup).not.toContain(action.argsDigest);
  });

  test('lets a Member decide their own requester-class action', () => {
    operationsStore.getState().upsertAction({
      ...action,
      risk: 'low',
      approvalClass: 'requester',
      requiresDistinctApprover: false,
    });
    Object.assign(operationsStore.getInitialState(), operationsStore.getState());
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <BotApprovalsTab
          botId={BOT_ID}
          canOperate
          principalId={USER_ID}
          operationsStore={operationsStore}
        />
      </I18nProvider>,
    );

    expect(markup).toContain('>Approve<');
    expect(markup).toContain('>Deny<');

    const otherRequesterMarkup = renderToStaticMarkup(
      <I18nProvider>
        <BotApprovalsTab
          botId={BOT_ID}
          canOperate
          principalId={OTHER_USER_ID}
          operationsStore={operationsStore}
        />
      </I18nProvider>,
    );
    expect(otherRequesterMarkup).toContain('Only the person who requested this action can decide it.');
    expect(otherRequesterMarkup).not.toContain('>Approve<');
  });

  test('requires a different approver for the requester of a sensitive action', () => {
    operationsStore.getState().upsertAction({ ...action, requiresDistinctApprover: true });
    Object.assign(operationsStore.getInitialState(), operationsStore.getState());
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <BotApprovalsTab
          botId={BOT_ID}
          canOperate
          principalId={action.initiatedBy}
          operationsStore={operationsStore}
        />
      </I18nProvider>,
    );

    expect(markup).toContain('A different Bot member must decide this action.');
    expect(markup).not.toContain('>Approve<');
    expect(markup).not.toContain('>Deny<');
  });

  test('lets any member decide legacy critical approvals without a role hierarchy', () => {
    operationsStore.getState().upsertAction({
      ...action,
      risk: 'critical',
      approvalClass: 'manager',
    });
    Object.assign(operationsStore.getInitialState(), operationsStore.getState());
    const memberMarkup = renderToStaticMarkup(
      <I18nProvider>
        <BotApprovalsTab
          botId={BOT_ID}
          canOperate
          principalId={OTHER_USER_ID}
          operationsStore={operationsStore}
        />
      </I18nProvider>,
    );
    expect(memberMarkup).toContain('>Approve<');
    expect(memberMarkup).toContain('>Deny<');

    operationsStore.getState().upsertAction({
      ...action,
      risk: 'critical',
      approvalClass: 'manager',
      requiresDistinctApprover: true,
    });
    Object.assign(operationsStore.getInitialState(), operationsStore.getState());
    const initiatingMemberMarkup = renderToStaticMarkup(
      <I18nProvider>
        <BotApprovalsTab
          botId={BOT_ID}
          canOperate
          principalId={USER_ID}
          operationsStore={operationsStore}
        />
      </I18nProvider>,
    );
    expect(initiatingMemberMarkup).toContain('A different Bot member must decide this action.');
    expect(initiatingMemberMarkup).not.toContain('>Approve<');

    const differentMemberMarkup = renderToStaticMarkup(
      <I18nProvider>
        <BotApprovalsTab
          botId={BOT_ID}
          canOperate
          principalId={OTHER_USER_ID}
          operationsStore={operationsStore}
        />
      </I18nProvider>,
    );
    expect(differentMemberMarkup).toContain('>Approve<');
  });

  test('shows Bot-wide approvals without requiring the originating channel run', () => {
    const crossChannelAction = {
      ...action,
      runId: 'f0000000-0000-4000-8000-000000000002',
      target: { origin: 'https://cross-channel.example.com' },
    };
    const otherBotAction = {
      ...action,
      id: 'a1000000-0000-4000-8000-000000000002',
      botId: OTHER_BOT_ID,
      runId: 'f0000000-0000-4000-8000-000000000003',
      target: { origin: 'https://other-bot.example.com' },
    };
    operationsStore.getState().replaceSnapshot({
      runs: [run],
      pendingApprovals: [crossChannelAction, otherBotAction],
      computers: [],
    });
    Object.assign(operationsStore.getInitialState(), operationsStore.getState());
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <BotApprovalsTab
          botId={BOT_ID}
          canOperate
          principalId={OTHER_USER_ID}
          operationsStore={operationsStore}
        />
      </I18nProvider>,
    );

    expect(markup).toContain('https://cross-channel.example.com');
    expect(markup).not.toContain('https://other-bot.example.com');
    expect(markup).toContain('>Approve<');

    const railMarkup = renderToStaticMarkup(
      <I18nProvider>
        <BotOperationsRail
          botId={BOT_ID}
          channelId={CHANNEL_ID}
          botsStore={botsStore}
          channelStore={channelStore}
          operationsStore={operationsStore}
        />
      </I18nProvider>,
    );
    expect(railMarkup).toContain('aria-label="Pending confirmations: 1"');
  });

  test('allows an initiating member to reconcile an unknown outcome', () => {
    operationsStore.getState().upsertAction({
      ...action,
      state: 'needs_reconciliation',
      unknownOutcome: true,
      requiresDistinctApprover: true,
    });
    Object.assign(operationsStore.getInitialState(), operationsStore.getState());
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <BotApprovalsTab
          botId={BOT_ID}
          canOperate
          principalId={USER_ID}
          operationsStore={operationsStore}
        />
      </I18nProvider>,
    );

    expect(markup).toContain('>Mark Complete<');
    expect(markup).toContain('>Retry as New<');
    expect(markup).toContain('>Abandon<');
    expect(markup).not.toContain('A different Bot member must decide this action.');
  });

  test('keeps expired approval decisions visible but disabled', () => {
    operationsStore.getState().upsertAction({
      ...action,
      decisionExpiresAt: '2000-01-01T00:00:00.000Z',
    });
    Object.assign(operationsStore.getInitialState(), operationsStore.getState());
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <BotApprovalsTab
          botId={BOT_ID}
          canOperate
          principalId={OTHER_USER_ID}
          operationsStore={operationsStore}
        />
      </I18nProvider>,
    );

    expect(markup).toContain('This decision window expired.');
    expect(/<button[^>]*disabled=""[^>]*>Deny<\/button>/.test(markup)).toBe(true);
    expect(/<button[^>]*disabled=""[^>]*>Approve<\/button>/.test(markup)).toBe(true);
  });

  test('reuses the existing mobile right drawer and suppresses repository surfaces in Bot mode', () => {
    const mainLayout = readFileSync(resolve(testDir, '../../layout/MainLayout.tsx'), 'utf8');
    const rightSidebar = readFileSync(resolve(testDir, '../../layout/RightSidebarTabs.tsx'), 'utf8');
    const header = readFileSync(resolve(testDir, '../../layout/Header.tsx'), 'utf8');

    expect(mainLayout).toContain('<motion.aside');
    expect(mainLayout).toContain('<ErrorBoundary><RightSidebarTabs /></ErrorBoundary>');
    expect(mainLayout).toContain('{!botMode ? <ContextPanel /> : null}');
    expect(mainLayout).toContain('{!botMode ? <BrowserPanel /> : null}');
    expect(mainLayout).toContain('canUseTerminal && !botMode');
    expect(rightSidebar).toContain('return <LazyViewBoundary><LazyBotOperationsRail');
    expect(rightSidebar).toContain("useMainSidebarAudienceStore((state) => state.audience === 'bots')");
    expect(rightSidebar).toContain('isRightSidebarOpen && canUseGit && !botMode');
    expect(rightSidebar).not.toContain('Boolean(selectedBotId)');
    expect(header).toContain('botMode ? renderBotDesktop() : renderDesktop()');
    expect(header).toContain('botMode ? renderBotMobile() : renderMobile()');
  });
});
