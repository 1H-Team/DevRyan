import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import type { BotRun } from '@/lib/botsApi';
import { useBotOperationsStore } from '@/stores/useBotOperationsStore';
import { BotRunFailureNotice } from './BotRunFailureNotice';
import { resolveBotRunFailureMessageKey } from '../botPresentation';

const failedRun = (id: string, overrides: Partial<BotRun> = {}): BotRun => ({
  id,
  botId: 'bot',
  channelId: 'channel',
  revisionId: 'v1',
  modelSnapshot: null,
  computerScopeKey: 'scope',
  queueSequence: null,
  state: 'failed',
  retryable: true,
  interruptionKind: null,
  createdAt: null,
  updatedAt: null,
  startedAt: null,
  finishedAt: null,
  ...overrides,
});

const renderNotice = (run: BotRun): string => {
  const operationsInitial = useBotOperationsStore.getInitialState();
  const previousRuns = useBotOperationsStore.getState().runsById;
  const previousInitialRuns = operationsInitial.runsById;
  try {
    const runsById = { [run.id]: run };
    useBotOperationsStore.setState({ runsById });
    Object.assign(operationsInitial, { runsById });
    return renderToStaticMarkup(
      <I18nProvider>
        <BotRunFailureNotice runId={run.id} channelId="channel" sourceHasAttachments={false} />
      </I18nProvider>,
    );
  } finally {
    useBotOperationsStore.setState({ runsById: previousRuns });
    Object.assign(operationsInitial, { runsById: previousInitialRuns });
  }
};

const STARTUP_CODES = [
  'bot_opencode_request_failed',
  'bot_opencode_request_aborted',
  'bot_agent_execution_lost',
  'bot_opencode_provider_unknown',
  'bot_opencode_api_retryable',
  'bot_agent_run_failed',
  'bot_opencode_start_timeout',
  'bot_opencode_request_timeout',
];

describe('BotRunFailureNotice copy', () => {
  test('blames the runtime, not the model, when the run failed while its runtime was starting', () => {
    for (const code of STARTUP_CODES) {
      expect(resolveBotRunFailureMessageKey(code, 'startup')).toBe('bots.chat.failure.runtimeStartup');
    }
    const markup = renderNotice(failedRun('startup', {
      interruptionKind: 'bot_opencode_request_failed',
      failurePhase: 'startup',
      failureStage: 'oauth_readiness',
    }));
    expect(markup).toContain('start in time');
    expect(markup).toContain('Retry to start it again');
    expect(markup).not.toContain('model connection failed');
    expect(markup).toContain('Retry safely');
  });

  test('keeps the model copy for execution-phase and phase-less provider failures', () => {
    expect(resolveBotRunFailureMessageKey('bot_opencode_request_failed', 'execution'))
      .toBe('bots.chat.failure.providerTransient');
    expect(resolveBotRunFailureMessageKey('bot_opencode_request_failed', null))
      .toBe('bots.chat.failure.providerTransient');
    expect(resolveBotRunFailureMessageKey('bot_opencode_request_failed'))
      .toBe('bots.chat.failure.providerTransient');
    expect(resolveBotRunFailureMessageKey('bot_opencode_request_timeout', 'execution'))
      .toBe('bots.chat.failure.timeout');
    expect(resolveBotRunFailureMessageKey('bot_opencode_start_timeout', 'execution'))
      .toBe('bots.chat.failure.runtimeUnavailable');

    const execution = renderNotice(failedRun('execution', {
      interruptionKind: 'bot_opencode_request_failed',
      failurePhase: 'execution',
    }));
    expect(execution).toContain('model connection failed before it could answer');
    expect(execution).not.toContain('start in time');

    const legacy = renderNotice(failedRun('legacy', { interruptionKind: 'bot_opencode_request_failed' }));
    expect(legacy).toContain('model connection failed before it could answer');
  });

  test('does not let a startup phase override unrelated failure codes', () => {
    expect(resolveBotRunFailureMessageKey('bot_opencode_content_filter', 'startup'))
      .toBe('bots.chat.failure.contentFilter');
    expect(resolveBotRunFailureMessageKey('bot_runtime_docker_unavailable', 'startup'))
      .toBe('bots.chat.failure.runtimeUnavailable');
    expect(resolveBotRunFailureMessageKey('bot_compiled_config_conflict', 'startup'))
      .toBe('bots.chat.failure.configuration');
    expect(resolveBotRunFailureMessageKey(null, 'startup')).toBe('bots.chat.failure.generic');
  });

  test('maps model-limit codes to their own copy and generic run failures to the model copy', () => {
    expect(resolveBotRunFailureMessageKey('bot_opencode_context_overflow'))
      .toBe('bots.chat.failure.contextOverflow');
    expect(resolveBotRunFailureMessageKey('bot_opencode_output_length'))
      .toBe('bots.chat.failure.outputLength');
    expect(resolveBotRunFailureMessageKey('bot_opencode_structured_output'))
      .toBe('bots.chat.failure.structuredOutput');
    expect(resolveBotRunFailureMessageKey('bot_opencode_run_failed'))
      .toBe('bots.chat.failure.providerTransient');

    expect(renderNotice(failedRun('overflow', { interruptionKind: 'bot_opencode_context_overflow' })))
      .toContain('too long for the Bot');
    expect(renderNotice(failedRun('length', { interruptionKind: 'bot_opencode_output_length' })))
      .toContain('output limit');
    expect(renderNotice(failedRun('structured', { interruptionKind: 'bot_opencode_structured_output' })))
      .toContain('unusable structured answer');
  });
});
