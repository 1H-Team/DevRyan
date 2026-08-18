import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import type { ManagedTaskProjection } from '@/lib/orchestrationApi';
import type { AgentHandoffViewState } from './agentHandoffCoordinator';

const { AgentHandoffDialogView } = await import('./AgentHandoffDialog');

const tasks: ManagedTaskProjection[] = Array.from({ length: 12 }, (_, index) => ({
  task: {
    owner: 'devryan',
    taskId: `dvr_task_${index + 1}`,
    rootSessionId: 'ses_root',
    dispatchCallId: null,
    dispatchGrouped: false,
    parentTaskId: null,
    childSessionId: null,
    directory: '/workspace',
    sequence: index + 1,
    mode: 'orchestrator',
    providerId: 'github-copilot',
    modelId: 'gpt-4.1',
    agent: 'explorer',
    variant: null,
    label: index === 0 ? 'A very long task label that must stay contained inside the scheduler row' : `Task ${index + 1}`,
    status: index < 3 ? 'running' : 'completed',
    attempt: 1,
    priorTaskId: null,
    executionKind: 'start',
    createdAt: 1_000 + index,
    startedAt: 1_100,
    finishedAt: index < 3 ? null : 2_000,
    timeoutAt: null,
    failureReason: null,
    failureKind: null,
    partial: false,
    recoverablePreview: '',
    canonicalRefs: [],
    agentRetryAvailable: true,
  },
}));

const state = (overrides: Partial<AgentHandoffViewState> = {}): AgentHandoffViewState => ({
  open: true,
  phase: 'confirmation',
  errorKind: null,
  sessionId: 'ses_root',
  tasks,
  failures: [],
  errorMessage: null,
  ...overrides,
});

describe('AgentHandoffDialogView', () => {
  test('renders ordered counts, ten rows, overflow summary, and safe focus order', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <AgentHandoffDialogView
          state={state()}
          onCancel={() => undefined}
          onConfirm={() => undefined}
          onRetry={() => undefined}
        />
      </I18nProvider>,
    );

    expect(html).toContain('3 active');
    expect(html).toContain('9 unreviewed');
    expect(html).toContain('A Very Long Task Label');
    expect(html).toContain('Task 10');
    expect(html).not.toContain('Task 11');
    expect(html).toContain('2 more tasks');
    expect(html.indexOf('Keep Orchestrator')).toBeLessThan(html.indexOf('Stop Tasks &amp; Switch'));
  });

  test('renders locked progress and a retryable role alert after failure', () => {
    const progress = renderToStaticMarkup(
      <I18nProvider>
        <AgentHandoffDialogView
          state={state({ phase: 'cleaning' })}
          onCancel={() => undefined}
          onConfirm={() => undefined}
          onRetry={() => undefined}
        />
      </I18nProvider>,
    );
    expect(progress).toContain('Stopping tasks and clearing results');
    expect(progress).toContain('disabled=""');

    const error = renderToStaticMarkup(
      <I18nProvider>
        <AgentHandoffDialogView
          state={state({
            phase: 'error',
            errorKind: 'cleanup',
            errorMessage: 'Cleanup could not finish.',
            failures: [{ taskId: 'dvr_task_2', code: 'cleanup_failed', message: 'Managed task cleanup failed' }],
          })}
          onCancel={() => undefined}
          onConfirm={() => undefined}
          onRetry={() => undefined}
        />
      </I18nProvider>,
    );
    expect(error).toContain('role="alert"');
    expect(error).toContain('Cleanup could not finish.');
    expect(error).toContain('Retry Cleanup');
    expect(error).toContain('Keep Orchestrator');
  });

  test('does not claim ownership or show zero counts when inspection itself fails', () => {
    const error = renderToStaticMarkup(
      <I18nProvider>
        <AgentHandoffDialogView
          state={state({
            phase: 'error',
            errorKind: 'inspection',
            tasks: [],
            errorMessage: 'Managed orchestration request failed (403)',
          })}
          onCancel={() => undefined}
          onConfirm={() => undefined}
          onRetry={() => undefined}
        />
      </I18nProvider>,
    );

    expect(error).toContain('Couldn’t check managed tasks');
    expect(error).toContain('Retry Check');
    expect(error).not.toContain('Orchestrator still owns managed task work');
    expect(error).not.toContain('0 active');
    expect(error).not.toContain('0 unreviewed');
  });
});
