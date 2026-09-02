import React from 'react';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import type { BotActionAttempt, BotCapabilities, BotMessage, BotRun, BotSummary } from '@/lib/botsApi';
import { useBotChannelStore } from '@/stores/useBotChannelStore';
import { useBotLiveMessageStore } from '@/stores/useBotLiveMessageStore';
import { useBotOperationsStore } from '@/stores/useBotOperationsStore';
import { resolveBotRuntimeRecovery } from '../botPresentation';
import { resolveBotTypingRunId, shouldShowBotTypingIndicator } from './botTypingState';
import { BotMessageList } from './BotMessageList';
import { BotMessageRow } from './BotMessageRow';
import { BotRunFailureNotice } from './BotRunFailureNotice';
import { BotTypingIndicator } from './BotTypingIndicator';

const testDir = dirname(fileURLToPath(import.meta.url));

const bot: BotSummary = {
  id: 'bot',
  name: 'Release Steward',
  title: 'Release operations lead',
  summary: 'Coordinates release work.',
  avatarUrl: '/api/bots/release-steward/avatar',
  avatarFallback: 'RS',
  lifecycle: 'active',
  tenancy: 'team',
  activeRevisionId: 'v1',
  createdAt: '2026-08-23T00:00:00.000Z',
  updatedAt: '2026-08-23T00:00:00.000Z',
  retiredAt: null,
};

const message = (id: string, sequence: number, runId: string): BotMessage => ({
  id,
  channelId: 'channel',
  runId,
  actorUserId: null,
  role: sequence % 2 ? 'user' : 'assistant',
  assistantPhase: sequence % 2 ? null : 'result',
  sequence,
  body: { text: 'message', attachmentIds: [] },
  attachmentCount: 0,
  createdAt: '2026-08-23T00:00:00.000Z',
  finalizedAt: '2026-08-23T00:00:01.000Z',
});

const run = (id: string, revisionId: string, state: BotRun['state'] = 'completed'): BotRun => ({
  id,
  botId: 'bot',
  channelId: 'channel',
  revisionId,
  modelSnapshot: null,
  computerScopeKey: 'scope',
  queueSequence: null,
  state,
  retryable: false,
  interruptionKind: null,
  createdAt: null,
  updatedAt: null,
  startedAt: null,
  finishedAt: null,
});

const governedAction = (runId: string): BotActionAttempt => ({
  id: 'governed-action',
  runId,
  botId: bot.id,
  revisionId: 'v1',
  credentialId: null,
  computerScopeKey: 'scope',
  actionHash: 'action-hash',
  argsDigest: 'args-digest',
  tool: 'browser',
  action: 'snapshot',
  target: {},
  risk: 'low',
  approvalClass: 'none',
  policyEffect: 'allow',
  policyRuleIds: [],
  decisionExpiresAt: '2026-08-23T00:05:00.000Z',
  requiresDistinctApprover: false,
  retainEvidence: false,
  state: 'failed',
  unknownOutcome: false,
  reconciliationDecision: null,
  initiatedBy: 'user',
  createdAt: '2026-08-23T00:00:00.000Z',
  updatedAt: '2026-08-23T00:00:01.000Z',
  startedAt: '2026-08-23T00:00:00.000Z',
  finishedAt: '2026-08-23T00:00:01.000Z',
});

describe('BotChatView', () => {
  test('keeps revisions, checkpoints, tools, and timeline chrome out of the transcript', () => {
    const source = readFileSync(resolve(testDir, 'BotMessageList.tsx'), 'utf8');
    expect(source).not.toContain('opencodeSegment');
    expect(source).not.toContain('segmentId');
    expect(source).not.toContain('revisionMarkers');
    expect(source).not.toContain('checkpoint');
    expect(source).not.toContain('tool');
    expect(source).not.toContain('border-l');
  });

  test('offers setup, update, or repair only for local desktop-advertised actions', () => {
    const capabilities = (state: string, runtime: Record<string, unknown>): BotCapabilities => ({
      available: false,
      state,
      code: null,
      owner: 'electron',
      canManageRuntime: true,
      canCreateBot: false,
      runtime,
    });

    expect(resolveBotRuntimeRecovery(capabilities('setup_required', { canSetup: true }), true)).toBe('setup');
    expect(resolveBotRuntimeRecovery(capabilities('image_update_available', { canUpdate: true }), true)).toBe('update');
    expect(resolveBotRuntimeRecovery(capabilities('runtime_degraded', { canRepair: true }), true)).toBe('repair');
    expect(resolveBotRuntimeRecovery(capabilities('setup_required', { canSetup: true }), false)).toBeNull();
  });

  test('uses the lazy Markdown renderer with repository file interactions disabled', () => {
    const source = readFileSync(resolve(testDir, 'BotMessageRow.tsx'), 'utf8');
    expect(source).toContain("from '@/components/chat/MarkdownRenderer'");
    expect(source).toContain('enableFileReferences={false}');
    expect(source).not.toContain('Session');
    expect(source).not.toContain('OpenCode');
  });

  test('uses the selected Bot name without rendering a transcript avatar for assistant messages', () => {
    const assistantMessage = message('assistant-message', 2, 'run');
    const previousMessages = useBotChannelStore.getState().messagesById;
    const initialState = useBotChannelStore.getInitialState();
    const previousInitialMessages = initialState.messagesById;
    const messagesById = { [assistantMessage.id]: assistantMessage };
    useBotChannelStore.setState({ messagesById });
    Object.assign(initialState, { messagesById });

    try {
      const markup = renderToStaticMarkup(
        <I18nProvider>
          <BotMessageRow bot={bot} messageId={assistantMessage.id} />
        </I18nProvider>,
      );

      expect(markup).toContain('Release Steward');
      expect(markup).toContain('aria-label="Message from Release Steward"');
      expect(markup).not.toContain('src="/api/bots/release-steward/avatar"');
      expect(markup).not.toContain('h-14 w-14');
      expect(markup).not.toContain('>Bot<');
    } finally {
      useBotChannelStore.setState({ messagesById: previousMessages });
      Object.assign(initialState, { messagesById: previousInitialMessages });
    }
  });

  test('renders the Bot\'s acknowledgment line as its own bubble without any separate acknowledgment copy', () => {
    const acknowledgment = {
      ...message('contextual-acknowledgment', 2, 'tool-run'),
      assistantPhase: 'acknowledgment' as const,
      body: {
        text: "I’ll open Buffer and check which account is connected.",
        attachmentIds: [],
      },
    };
    const previousMessages = useBotChannelStore.getState().messagesById;
    const initialState = useBotChannelStore.getInitialState();
    const previousInitialMessages = initialState.messagesById;
    const messagesById = { [acknowledgment.id]: acknowledgment };
    useBotChannelStore.setState({ messagesById });
    Object.assign(initialState, { messagesById });

    try {
      const markup = renderToStaticMarkup(
        <I18nProvider>
          <BotMessageRow bot={bot} messageId={acknowledgment.id} />
        </I18nProvider>,
      );

      const rowSource = readFileSync(resolve(testDir, 'BotMessageRow.tsx'), 'utf8');
      expect(markup).toContain('data-bot-message-phase="acknowledgment"');
      expect(markup).toContain('open Buffer and check which account is connected');
      expect(useBotChannelStore.getState().messagesById[acknowledgment.id]).toBe(acknowledgment);
      expect(rowSource).not.toContain('bots.chat.message.acknowledgment');
      expect(markup).not.toContain('Got it — I’m on it.');
    } finally {
      useBotChannelStore.setState({ messagesById: previousMessages });
      Object.assign(initialState, { messagesById: previousInitialMessages });
    }
  });

  test('keeps governed activity out of assistant responses', () => {
    const assistantMessage = {
      ...message('assistant-with-activity', 2, 'activity-run'),
      body: { text: 'I could not inspect the current page.', attachmentIds: [] },
    };
    const action = governedAction('activity-run');
    const channelInitialState = useBotChannelStore.getInitialState();
    const operationsInitialState = useBotOperationsStore.getInitialState();
    const previousMessages = useBotChannelStore.getState().messagesById;
    const previousInitialMessages = channelInitialState.messagesById;
    const previousOperations = {
      runsById: useBotOperationsStore.getState().runsById,
      actionsById: useBotOperationsStore.getState().actionsById,
      actionIdsByRunId: useBotOperationsStore.getState().actionIdsByRunId,
    };
    const previousInitialOperations = {
      runsById: operationsInitialState.runsById,
      actionsById: operationsInitialState.actionsById,
      actionIdsByRunId: operationsInitialState.actionIdsByRunId,
    };
    const messagesById = { [assistantMessage.id]: assistantMessage };
    const runsById = { 'activity-run': run('activity-run', 'v1') };
    const actionsById = { [action.id]: action };
    const actionIdsByRunId = { 'activity-run': [action.id] };
    useBotChannelStore.setState({ messagesById });
    useBotOperationsStore.setState({ runsById, actionsById, actionIdsByRunId });
    Object.assign(channelInitialState, { messagesById });
    Object.assign(operationsInitialState, { runsById, actionsById, actionIdsByRunId });

    try {
      const markup = renderToStaticMarkup(
        <I18nProvider><BotMessageRow bot={bot} messageId={assistantMessage.id} /></I18nProvider>,
      );

      expect(markup).toContain('data-bot-message-id="assistant-with-activity"');
      expect(markup).not.toContain('browser · snapshot · failed');
      expect(markup).not.toContain('View Activity');
      expect(markup).not.toContain('data-bot-transcript-action-id');
    } finally {
      useBotChannelStore.setState({ messagesById: previousMessages });
      useBotOperationsStore.setState(previousOperations);
      Object.assign(channelInitialState, { messagesById: previousInitialMessages });
      Object.assign(operationsInitialState, previousInitialOperations);
    }
  });

  test('keeps unfinalized prose hidden for both running and cancelled work', () => {
    const assistantMessage = {
      ...message('settled-assistant-message', 2, 'settled-run'),
      finalizedAt: null,
    };
    const previousMessages = useBotChannelStore.getState().messagesById;
    const previousRuns = useBotOperationsStore.getState().runsById;
    const channelInitialState = useBotChannelStore.getInitialState();
    const operationsInitialState = useBotOperationsStore.getInitialState();
    const previousInitialMessages = channelInitialState.messagesById;
    const previousInitialRuns = operationsInitialState.runsById;
    const messagesById = { [assistantMessage.id]: assistantMessage };
    useBotChannelStore.setState({ messagesById });
    Object.assign(channelInitialState, { messagesById });

    try {
      const cancelledRuns = { 'settled-run': run('settled-run', 'v1', 'cancelled') };
      useBotOperationsStore.setState({ runsById: cancelledRuns });
      Object.assign(operationsInitialState, { runsById: cancelledRuns });
      const settledMarkup = renderToStaticMarkup(
        <I18nProvider><BotMessageRow bot={bot} messageId={assistantMessage.id} /></I18nProvider>,
      );
      expect(settledMarkup).toBe('');

      const runningRuns = { 'settled-run': run('settled-run', 'v1', 'running') };
      useBotOperationsStore.setState({ runsById: runningRuns });
      Object.assign(operationsInitialState, { runsById: runningRuns });
      const runningMarkup = renderToStaticMarkup(
        <I18nProvider><BotMessageRow bot={bot} messageId={assistantMessage.id} /></I18nProvider>,
      );
      expect(runningMarkup).toBe('');
    } finally {
      useBotChannelStore.setState({ messagesById: previousMessages });
      useBotOperationsStore.setState({ runsById: previousRuns });
      Object.assign(channelInitialState, { messagesById: previousInitialMessages });
      Object.assign(operationsInitialState, { runsById: previousInitialRuns });
    }
  });

  test('buffers requester-only live prose until a verified canonical final exists', () => {
    const liveState = useBotLiveMessageStore.getState();
    const liveInitialState = useBotLiveMessageStore.getInitialState();
    const previousInitialMessages = liveInitialState.messagesById;
    try {
      liveState.reset();
      liveState.upsert({
        messageId: 'live-assistant',
        runId: 'live-run',
        channelId: 'channel',
        sequence: 2,
        createdAt: '2026-08-26T12:00:00.000Z',
        text: '**First streamed text**',
        revision: 1,
      });
      Object.assign(liveInitialState, {
        messagesById: useBotLiveMessageStore.getState().messagesById,
      });

      const markup = renderToStaticMarkup(
        <I18nProvider><BotMessageRow bot={bot} messageId="live-assistant" /></I18nProvider>,
      );

      expect(markup).toBe('');
    } finally {
      useBotLiveMessageStore.getState().reset();
      Object.assign(liveInitialState, { messagesById: previousInitialMessages });
    }
  });

  test('marks an ambiguous optimistic message as Not confirmed', () => {
    const optimistic: BotMessage = {
      ...message('unconfirmed-message', 1, ''),
      runId: null,
      actorUserId: 'user',
      finalizedAt: null,
    };
    const initialState = useBotChannelStore.getInitialState();
    const previousMessages = useBotChannelStore.getState().messagesById;
    const previousUnconfirmed = useBotChannelStore.getState().unconfirmedMessageIds;
    const previousInitialMessages = initialState.messagesById;
    const previousInitialUnconfirmed = initialState.unconfirmedMessageIds;
    try {
      const messagesById = { [optimistic.id]: optimistic };
      const unconfirmedMessageIds = { [optimistic.id]: true as const };
      useBotChannelStore.setState({ messagesById, unconfirmedMessageIds });
      Object.assign(initialState, { messagesById, unconfirmedMessageIds });

      const markup = renderToStaticMarkup(
        <I18nProvider><BotMessageRow bot={bot} messageId={optimistic.id} /></I18nProvider>,
      );
      expect(markup).toContain('Not confirmed');
      expect(markup).toContain('role="status"');
    } finally {
      useBotChannelStore.setState({
        messagesById: previousMessages,
        unconfirmedMessageIds: previousUnconfirmed,
      });
      Object.assign(initialState, {
        messagesById: previousInitialMessages,
        unconfirmedMessageIds: previousInitialUnconfirmed,
      });
    }
  });

  test('does not render an empty assistant checkpoint as an avatar-only bubble', () => {
    const emptyMessage = {
      ...message('empty-assistant-message', 2, 'empty-run'),
      body: { text: '   ', attachmentIds: [] },
    };
    const channelInitialState = useBotChannelStore.getInitialState();
    const previousMessages = useBotChannelStore.getState().messagesById;
    const previousInitialMessages = channelInitialState.messagesById;
    const messagesById = { [emptyMessage.id]: emptyMessage };
    useBotChannelStore.setState({ messagesById });
    Object.assign(channelInitialState, { messagesById });

    try {
      expect(renderToStaticMarkup(
        <I18nProvider><BotMessageRow bot={bot} messageId={emptyMessage.id} /></I18nProvider>,
      )).toBe('');
    } finally {
      useBotChannelStore.setState({ messagesById: previousMessages });
      Object.assign(channelInitialState, { messagesById: previousInitialMessages });
    }
  });

  test('renders failed runs inline after empty or partial assistant checkpoints', () => {
    const failedRun = {
      ...run('failed-run', 'v1', 'failed'),
      retryable: true,
      interruptionKind: 'bot_opencode_api_retryable',
    };
    const userMessage: BotMessage = {
      ...message('failed-user', 1, failedRun.id),
      actorUserId: 'user',
      body: { text: 'Review this', attachmentIds: ['attachment'] },
      attachmentCount: 1,
    };
    const emptyAssistant: BotMessage = {
      ...message('failed-empty-assistant', 2, failedRun.id),
      body: { text: '', attachmentIds: [] },
      finalizedAt: '2026-08-23T00:00:02.000Z',
    };
    const partialAssistant: BotMessage = {
      ...emptyAssistant,
      id: 'failed-partial-assistant',
      body: { text: 'I reviewed part of', attachmentIds: [] },
    };
    const channelState = useBotChannelStore.getState();
    const channelInitial = useBotChannelStore.getInitialState();
    const operationsState = useBotOperationsStore.getState();
    const operationsInitial = useBotOperationsStore.getInitialState();
    const priorChannel = {
      messagesById: channelState.messagesById,
      messageIdsByChannelId: channelState.messageIdsByChannelId,
    };
    const priorInitialChannel = {
      messagesById: channelInitial.messagesById,
      messageIdsByChannelId: channelInitial.messageIdsByChannelId,
    };
    const priorRuns = operationsState.runsById;
    const priorInitialRuns = operationsInitial.runsById;

    try {
      const renderMessages = (assistant: BotMessage) => {
        const messagesById = { [userMessage.id]: userMessage, [assistant.id]: assistant };
        const messageIdsByChannelId = { channel: [userMessage.id, assistant.id] };
        useBotChannelStore.setState({ messagesById, messageIdsByChannelId });
        Object.assign(channelInitial, { messagesById, messageIdsByChannelId });
        const runsById = { [failedRun.id]: failedRun };
        useBotOperationsStore.setState({ runsById });
        Object.assign(operationsInitial, { runsById });
        return renderToStaticMarkup(
          <I18nProvider>
            <BotMessageList bot={bot} channelId="channel" typingRunId={null} />
          </I18nProvider>,
        );
      };

      const emptyMarkup = renderMessages(emptyAssistant);
      expect(emptyMarkup).toContain('data-bot-run-failure="failed-run"');
      expect(emptyMarkup).not.toContain('data-bot-message-id="failed-empty-assistant"');

      const partialMarkup = renderMessages(partialAssistant);
      expect(partialMarkup).toContain('data-bot-message-id="failed-partial-assistant"');
      expect(partialMarkup.indexOf('data-bot-message-id="failed-partial-assistant"'))
        .toBeLessThan(partialMarkup.indexOf('data-bot-run-failure="failed-run"'));
      expect(partialMarkup).toContain('Retry safely');
    } finally {
      useBotChannelStore.setState(priorChannel);
      Object.assign(channelInitial, priorInitialChannel);
      useBotOperationsStore.setState({ runsById: priorRuns });
      Object.assign(operationsInitial, { runsById: priorInitialRuns });
    }
  });

  test('offers Retry only for retryable failures and locks it while a send is pending', () => {
    const channelInitial = useBotChannelStore.getInitialState();
    const operationsInitial = useBotOperationsStore.getInitialState();
    const previousPending = useBotChannelStore.getState().pendingMessageIdByChannelId;
    const previousInitialPending = channelInitial.pendingMessageIdByChannelId;
    const previousRuns = useBotOperationsStore.getState().runsById;
    const previousInitialRuns = operationsInitial.runsById;
    try {
      const retryableRun = {
        ...run('retryable', 'v1', 'failed'),
        retryable: true,
        interruptionKind: 'bot_opencode_context_overflow',
      };
      const runsById = { retryable: retryableRun };
      const pendingMessageIdByChannelId = { channel: 'pending-message' };
      useBotChannelStore.setState({ pendingMessageIdByChannelId });
      Object.assign(channelInitial, { pendingMessageIdByChannelId });
      useBotOperationsStore.setState({ runsById });
      Object.assign(operationsInitial, { runsById });
      const locked = renderToStaticMarkup(
        <I18nProvider>
          <BotRunFailureNotice runId="retryable" channelId="channel" sourceHasAttachments={false} />
        </I18nProvider>,
      );
      expect(locked).toContain('Retry safely');
      expect(locked).toContain('disabled=""');

      const nonRetryable = {
        ...retryableRun,
        id: 'blocked',
        retryable: false,
        interruptionKind: 'bot_opencode_content_filter',
      };
      const blockedRuns = { blocked: nonRetryable };
      useBotOperationsStore.setState({ runsById: blockedRuns });
      Object.assign(operationsInitial, { runsById: blockedRuns });
      const blocked = renderToStaticMarkup(
        <I18nProvider>
          <BotRunFailureNotice runId="blocked" channelId="channel" sourceHasAttachments={false} />
        </I18nProvider>,
      );
      expect(blocked).toContain('cannot be retried unchanged');
      expect(blocked).not.toContain('Retry safely');
    } finally {
      useBotChannelStore.setState({ pendingMessageIdByChannelId: previousPending });
      Object.assign(channelInitial, { pendingMessageIdByChannelId: previousInitialPending });
      useBotOperationsStore.setState({ runsById: previousRuns });
      Object.assign(operationsInitial, { runsById: previousInitialRuns });
    }
  });

  test('surfaces generated runtime configuration failures as actionable pre-execution failures', () => {
    const operationsInitial = useBotOperationsStore.getInitialState();
    const previousRuns = useBotOperationsStore.getState().runsById;
    const previousInitialRuns = operationsInitial.runsById;
    try {
      const configurationRun = {
        ...run('configuration', 'v1', 'failed'),
        retryable: true,
        interruptionKind: 'bot_compiled_config_conflict',
      };
      const runsById = { configuration: configurationRun };
      useBotOperationsStore.setState({ runsById });
      Object.assign(operationsInitial, { runsById });
      const markup = renderToStaticMarkup(
        <I18nProvider>
          <BotRunFailureNotice
            runId="configuration"
            channelId="channel"
            sourceHasAttachments={false}
          />
        </I18nProvider>,
      );
      expect(markup).toContain('runtime configuration could not start');
      expect(markup).toContain('Retry safely');
    } finally {
      useBotOperationsStore.setState({ runsById: previousRuns });
      Object.assign(operationsInitial, { runsById: previousInitialRuns });
    }
  });

  test('does not blame attachments for OAuth or timeout failures', () => {
    const operationsInitial = useBotOperationsStore.getInitialState();
    const previousRuns = useBotOperationsStore.getState().runsById;
    const previousInitialRuns = operationsInitial.runsById;
    try {
      const oauth = {
        ...run('oauth', 'v1', 'failed'),
        retryable: true,
        interruptionKind: 'bot_opencode_request_failed',
      };
      const timeout = {
        ...run('timeout', 'v1', 'failed'),
        retryable: false,
        interruptionKind: 'bot_opencode_request_timeout',
      };
      const attachments = {
        ...run('attachments', 'v1', 'failed'),
        retryable: false,
        interruptionKind: 'bot_artifact_materialization_failed',
      };
      const runsById = { oauth, timeout, attachments };
      useBotOperationsStore.setState({ runsById });
      Object.assign(operationsInitial, { runsById });

      const renderFailure = (runId: string) => renderToStaticMarkup(
        <I18nProvider>
          <BotRunFailureNotice runId={runId} channelId="channel" sourceHasAttachments />
        </I18nProvider>,
      );
      expect(renderFailure('oauth')).toContain('model connection failed before it could answer');
      expect(renderFailure('oauth')).not.toContain('processing the attached files');
      expect(renderFailure('timeout')).toContain('response time limit');
      expect(renderFailure('timeout')).not.toContain('processing the attached files');
      expect(renderFailure('attachments')).toContain('processing the attached files');
    } finally {
      useBotOperationsStore.setState({ runsById: previousRuns });
      Object.assign(operationsInitial, { runsById: previousInitialRuns });
    }
  });

  test('removes channel metadata and warms only from explicit composer intent', () => {
    const chatSource = readFileSync(resolve(testDir, 'BotChatView.tsx'), 'utf8');
    const composerSource = readFileSync(resolve(testDir, 'BotComposer.tsx'), 'utf8');
    expect(chatSource).not.toContain("t('bots.chat.privateContinuity')");
    expect(chatSource).not.toContain('t(`bots.composer.access.${channel.accessRole}`)');
    expect(chatSource).not.toContain('BotRunStatus');
    expect(chatSource).toContain('onRuntimeIntent={requestRuntimePrewarm}');
    expect(chatSource).not.toContain("if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(latestRun.state))");
    expect(composerSource).toContain('onFocusCapture={onRuntimeIntent}');
    expect(composerSource).toContain('onPointerDownCapture={onRuntimeIntent}');
    expect(composerSource).toContain('onRuntimeIntent?.();');
    const rowSource = readFileSync(resolve(testDir, 'BotMessageRow.tsx'), 'utf8');
    expect(rowSource).toContain('min-w-0 max-w-[92%] sm:max-w-[78%]');
    expect(rowSource).not.toContain('showAvatar');
    expect(rowSource).not.toContain('<BotAvatar');
  });

  test('derives typing from queued, starting, and running states only', () => {
    expect(resolveBotTypingRunId(run('queued', 'v1', 'queued'))).toBe('queued');
    expect(resolveBotTypingRunId(run('starting', 'v1', 'starting'))).toBe('starting');
    expect(resolveBotTypingRunId(run('running', 'v1', 'running'))).toBe('running');
    for (const state of ['waiting_approval', 'needs_reconciliation', 'completed', 'failed', 'cancelled', 'interrupted'] as const) {
      expect(resolveBotTypingRunId(run(state, 'v1', state))).toBeNull();
    }
    expect(resolveBotTypingRunId(null)).toBeNull();
  });

  test('keeps working feedback through acknowledgments and partial prose until final output', () => {
    const emptyCheckpoint = {
      ...message('empty-checkpoint', 2, 'active-run'),
      body: { text: '   ', attachmentIds: [] },
      attachmentCount: 0,
      finalizedAt: null,
    };
    const visibleText = {
      ...emptyCheckpoint,
      id: 'visible-text',
      body: { text: 'Hello', attachmentIds: [] },
    };
    const visibleAttachment = {
      ...emptyCheckpoint,
      id: 'visible-attachment',
      attachmentCount: 1,
      body: { text: '', attachmentIds: ['attachment'] },
    };
    const acknowledgment = {
      ...visibleText,
      id: 'acknowledgment',
      assistantPhase: 'acknowledgment' as const,
      finalizedAt: '2026-08-23T00:00:02.000Z',
    };

    expect(shouldShowBotTypingIndicator({
      typingRunId: 'active-run',
      messageIds: [emptyCheckpoint.id],
      messagesById: { [emptyCheckpoint.id]: emptyCheckpoint },
    })).toBe(true);
    expect(shouldShowBotTypingIndicator({
      typingRunId: 'active-run',
      messageIds: [visibleText.id],
      messagesById: { [visibleText.id]: visibleText },
    })).toBe(true);
    expect(shouldShowBotTypingIndicator({
      typingRunId: 'active-run',
      messageIds: [visibleAttachment.id],
      messagesById: { [visibleAttachment.id]: visibleAttachment },
    })).toBe(true);
    expect(shouldShowBotTypingIndicator({
      typingRunId: 'active-run',
      messageIds: [acknowledgment.id],
      messagesById: { [acknowledgment.id]: acknowledgment },
    })).toBe(true);
    expect(shouldShowBotTypingIndicator({
      typingRunId: 'active-run',
      messageIds: [visibleText.id],
      messagesById: { [visibleText.id]: { ...visibleText, finalizedAt: '2026-08-23T00:00:03.000Z' } },
    })).toBe(false);
    expect(shouldShowBotTypingIndicator({
      typingRunId: null,
      messageIds: [],
      messagesById: {},
    })).toBe(false);
  });

  test('renders accessible avatar-free typing dots with reduced-motion support', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider><BotTypingIndicator bot={bot} /></I18nProvider>,
    );

    expect(markup).toContain('aria-label="Release Steward is typing"');
    expect(markup).toContain('data-bot-typing-indicator="bot"');
    expect(markup).not.toContain('src="/api/bots/release-steward/avatar"');
    expect(markup).not.toContain('h-14 w-14');
    expect(markup.match(/animate-bot-typing-dot/g)?.length).toBe(3);
    expect(markup).toContain('motion-reduce:animate-none');
  });

  test('follows intrinsic transcript growth while pinned and keeps a non-observer fallback', () => {
    const listSource = readFileSync(resolve(testDir, 'BotMessageList.tsx'), 'utf8');
    expect(listSource.match(/new ResizeObserver/g)).toHaveLength(1);
    expect(listSource).toContain('observer.observe(content)');
    expect(listSource).toContain('if (!element || !pinnedRef.current) return;');
    expect(listSource).toContain('if (!resizeObserverAvailableRef.current) scrollToBottom();');
    expect(listSource).toContain("style={{ overflowAnchor: 'none' }}");
  });

  test('resets following per channel and preserves the viewport when older messages prepend', () => {
    const listSource = readFileSync(resolve(testDir, 'BotMessageList.tsx'), 'utf8');
    expect(listSource).toContain('pinnedRef.current = true;');
    expect(listSource).toContain('[channelId, scrollToBottom]');
    expect(listSource).toContain('restoreBotPrependScrollTop({');
    expect(listSource).toContain('pinnedRef.current = false;');
    expect(listSource).toContain('isWithinBotAutoFollowThreshold(');
  });

  test('uses a content-driven Bot identity header without sidebar controls', () => {
    const header = readFileSync(resolve(testDir, '../../layout/Header.tsx'), 'utf8');
    const identityHeader = readFileSync(resolve(testDir, 'BotIdentityHeader.tsx'), 'utf8');
    const botHeader = header.slice(header.indexOf('const renderBotDesktop'), header.indexOf('const renderBotMobile'));
    const mobileBotHeader = header.slice(header.indexOf('const renderBotMobile'), header.indexOf('const renderDesktop'));

    expect(botHeader).toContain('<BotIdentityHeader');
    expect(botHeader).not.toContain('macosHeaderSizeClass');
    expect(botHeader).not.toContain('SidebarLeft');
    expect(botHeader).not.toContain('SidebarRight');
    expect(botHeader).not.toContain('HeaderIconActionButton');

    expect(mobileBotHeader).toContain('<BotIdentityHeader');
    expect(mobileBotHeader).not.toContain('<button');
    expect(mobileBotHeader).not.toContain('SidebarLeft');
    expect(mobileBotHeader).not.toContain('SidebarRight');

    expect(identityHeader).toContain('min-h-[88px]');
    expect(/\sh-\[88px\]\s/.test(identityHeader)).toBe(false);
    expect(identityHeader).toContain('data-bot-identity-header="desktop"');
    expect(identityHeader).toContain('data-bot-identity-header="mobile"');
    expect(identityHeader).toContain('<BotAvatar bot={bot} className="h-16 w-16 shrink-0 rounded-full');
    expect(identityHeader).toContain('flex min-h-16 min-w-0 flex-1 flex-col justify-center');
    expect(identityHeader).toContain('line-clamp-2 break-words');
    expect(identityHeader).toContain('{bot?.name');
    expect(identityHeader).toContain('{bot.title}');
    expect(identityHeader).not.toContain('<button');
    expect(identityHeader).not.toContain('RiRobot');
    expect(identityHeader).not.toContain('Private channel');
  });

  test('keeps VS Code deliberate and free of desktop runtime mutation calls', () => {
    const botView = readFileSync(resolve(testDir, '../../views/BotView.tsx'), 'utf8');
    const vscodeLayout = readFileSync(resolve(testDir, '../../layout/VSCodeLayout.tsx'), 'utf8');
    const englishMessages = readFileSync(resolve(testDir, '../../../lib/i18n/messages/en.ts'), 'utf8');

    expect(englishMessages).toContain("'bots.vscode.required': 'Bots require the DevRyan macOS app'");
    expect(botView).toContain('if (vscode) return <UnsupportedBotsView vscode />');
    expect(vscodeLayout).toContain('<LazyBotView />');
    expect(vscodeLayout).not.toContain('botsDesktopApi');
    expect(vscodeLayout).not.toContain('desktop_bot_runtime_setup');
  });

  test('uses Electron operation progress for runtime recovery without local pending state', () => {
    const source = readFileSync(resolve(testDir, 'BotChatView.tsx'), 'utf8');

    expect(source).toContain('useBotRuntimeOperation(botsDesktopApi)');
    expect(source).toContain('botRuntimeProgressLabel(runtimeOperation.progress, t)');
    expect(source).toContain('pending: runtimeOperation.pending');
    expect(source).toContain("runtimeOperation.progress?.phase === 'failed'");
    expect(source).toContain('runtimeOperation.progress.message || null');
    expect(source).toContain("phase !== 'ready' && phase !== 'failed'");
    expect(source).toContain('void useBotsStore.getState().loadCapabilities()');
    expect(source).not.toContain('setRuntimeActionPending');
  });
});
