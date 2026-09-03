import React from 'react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  createManagedTaskRecord,
  createManagedTaskResultEnvelope,
  toManagedTaskEvent,
  type ManagedTaskEventRecord,
  type ManagedTaskRecord,
  type ManagedTaskStatus,
} from '@openchamber/orchestration-runtime';

import { I18nProvider } from '@/lib/i18n';
import type {
  ManagedTaskAutoResume,
  ManagedTaskProjectedEnvelope,
  ManagedTaskWaitingReason,
} from '@/lib/orchestrationApi';

mock.module('@/components/ui/ProviderLogo', () => ({
  ProviderLogo: ({ providerId }: { providerId: string }) => React.createElement('img', { src: `/logos/${providerId}.svg` }),
}));
// The connected row reads the child's live status; there is no sync provider in these tests.
// `session-ui-store` (imported by the row) also binds `setActiveSession`, so the
// mock must export it or the store fails to link against the mocked module.
mock.module('@/sync/sync-context', () => ({
  useSessionStatus: () => undefined,
  setActiveSession: () => undefined,
}));
// Static markup cannot receive clicks, so capture the checkbox's change handler instead.
let latestCheckboxChange: ((checked: boolean) => void) | null = null;
mock.module('@/components/ui/checkbox', () => ({
  Checkbox: ({ checked, onChange, disabled, ariaLabel }: {
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabled?: boolean;
    ariaLabel?: string;
  }) => {
    latestCheckboxChange = onChange;
    return React.createElement('button', {
      type: 'button',
      role: 'checkbox',
      'aria-checked': checked ? 'true' : 'false',
      'aria-label': ariaLabel,
      disabled,
    });
  },
}));

// zustand's hook serves `getInitialState()` to the server renderer, so a
// connected row would never see seeded state. Swap the hook for a static
// selector over a real store instance; `getState()` and friends stay real.
const storeModule = { ...(await import('@/stores/useManagedOrchestrationStore')) };
const store = storeModule.createManagedOrchestrationStore({
  api: {
    async handoff() { throw new Error('not implemented'); },
    async getSnapshot() { return { available: true, bridgeReady: true, recoveryWarning: null, tasks: [], resultEnvelopes: [] }; },
    async getTask() { throw new Error('not implemented'); },
    async cancelTask() { throw new Error('not implemented'); },
    async acknowledgeTask() { throw new Error('not implemented'); },
    async setAutoResume() { throw new Error('not implemented'); },
  },
});
mock.module('@/stores/useManagedOrchestrationStore', () => ({
  ...storeModule,
  useManagedOrchestrationStore: Object.assign(
    <T,>(selector: (state: ReturnType<typeof store.getState>) => T) => selector(store.getState()),
    store,
  ),
}));

const { ManagedTaskRow, ManagedTaskRowView } = await import('./ManagedTaskRow');

const record = (
  taskId: string,
  status: ManagedTaskStatus,
  overrides: Partial<ManagedTaskRecord> = {},
): ManagedTaskRecord => ({
  ...createManagedTaskRecord({
    taskId,
    idempotencyKey: taskId,
    rootSessionId: 'ses_root',
    parentTaskId: null,
    directory: '/workspace',
    sequence: 1,
    mode: 'orchestrator',
    providerId: 'github-copilot',
    modelId: 'gpt-4.1',
    agent: 'explorer',
    variant: null,
    label: 'Map the workspace',
    prompt: 'Map it.',
    attempt: 1,
    priorTaskId: null,
    executionKind: 'start',
    createdAt: 1_000,
    timeoutAt: null,
  }),
  status,
  childSessionId: 'ses_child',
  ...(status === 'queued' ? {} : { startedAt: 1_100 }),
  ...(['completed', 'failed', 'aborted', 'interrupted'].includes(status) ? { finishedAt: 2_000 } : {}),
  ...overrides,
});

const autoResumeBlock = (overrides: Partial<ManagedTaskAutoResume> = {}): ManagedTaskAutoResume => ({
  revision: 1,
  enabled: true,
  state: 'scheduled',
  cancelGeneration: 0,
  lineageStartedAt: 2_000,
  expiresAt: 40_000,
  attemptCount: 0,
  noSignalProbes: 0,
  rejectionsInWindow: 0,
  windowResetAt: null,
  nextAttemptAt: 10_000,
  resetAt: 9_000,
  resetSource: 'opencode_status',
  target: { kind: 'backup', providerId: 'anthropic', modelId: 'claude-sonnet-5', variant: null },
  lastAttemptTaskId: null,
  lastAttemptAt: null,
  lastError: null,
  hostFailures: 0,
  reason: null,
  ...overrides,
});

/** A terminal failure of `failureKind` whose envelope is resumable and still unacknowledged. */
const manualRecoveryFailure = (
  failureKind: 'provider_usage_limit' | 'model_unavailable',
  autoResume: ManagedTaskAutoResume | null,
) => {
  const failed = record('dvr_task_limit', 'failed', {
    failureReason: failureKind === 'provider_usage_limit' ? 'usage limit reached' : 'model unavailable',
    partial: true,
    recoverablePreview: 'Partial result',
  });
  const baseEnvelope = createManagedTaskResultEnvelope(failed, {
    sequence: 1,
    createdAt: 2_000,
    resumable: true,
  });
  const envelope: ManagedTaskProjectedEnvelope = { ...baseEnvelope, providerResetAt: 9_000, autoResume };
  const task: ManagedTaskEventRecord = {
    ...toManagedTaskEvent(failed, baseEnvelope).properties.task,
    failureKind,
    agentRetryAvailable: false,
  };
  return { task, envelope };
};

const ingest = (task: ManagedTaskEventRecord, resultEnvelope?: ManagedTaskProjectedEnvelope) => {
  store.getState().ingestEvent({
    type: 'openchamber:managed-task',
    properties: {
      owner: 'devryan',
      directory: '/workspace',
      task,
      ...(resultEnvelope ? { resultEnvelope } : {}),
    },
  });
};

const renderView = (element: React.ReactElement) => renderToStaticMarkup(
  <I18nProvider>{element}</I18nProvider>,
);

afterEach(() => {
  latestCheckboxChange = null;
  store.getState().reset();
});

describe('ManagedTaskRow', () => {
  test('shows Starting model… between the child prompt and the first assistant part', () => {
    const running = toManagedTaskEvent(record('dvr_task_run', 'running')).properties.task;

    const starting = renderView(
      <ManagedTaskRowView
        task={{ ...running, childPromptedAt: 1_200, firstAssistantPartAt: null }}
        onOpenChild={() => undefined}
      />,
    );
    expect(starting).toContain('Starting model…');
    expect(starting).not.toContain('Running...');

    const streaming = renderView(
      <ManagedTaskRowView
        task={{ ...running, childPromptedAt: 1_200, firstAssistantPartAt: 1_500 }}
        onOpenChild={() => undefined}
      />,
    );
    expect(streaming).toContain('Running...');
    expect(streaming).not.toContain('Starting model…');

    const legacy = renderView(<ManagedTaskRowView task={running} onOpenChild={() => undefined} />);
    expect(legacy).toContain('Running...');
  });

  test('says why a queued task is waiting on the scheduler', () => {
    const queued = toManagedTaskEvent(record('dvr_task_wait', 'queued')).properties.task;
    const render = (waitingReason: ManagedTaskWaitingReason | null) => renderView(
      <ManagedTaskRowView task={{ ...queued, waitingReason }} onOpenChild={() => undefined} />,
    );

    const capped = render({ kind: 'capacity', activeCount: 4, limit: 4, since: 1_050 });
    expect(capped).toContain('Waiting for a free slot (4 of 4 running)');
    expect(capped).not.toContain('Queued...');

    const uncapped = render({ kind: 'capacity', activeCount: 3, limit: null, since: 1_050 });
    expect(uncapped).toContain('Waiting for a free slot');
    expect(uncapped).not.toContain('running)');

    expect(render({ kind: 'system_pressure', activeCount: 2, limit: null, since: 1_050 }))
      .toContain('Waiting for memory pressure to ease');

    const plain = render(null);
    expect(plain).toContain('Queued...');
    expect(plain).not.toContain('Waiting for');
  });

  test('announces the automatic continuation on the attempt the prior envelope launched', () => {
    const { envelope } = manualRecoveryFailure('provider_usage_limit', autoResumeBlock({
      revision: 3,
      state: 'attempting',
      attemptCount: 1,
      lastAttemptTaskId: 'dvr_task_backup',
    }));
    const backup = toManagedTaskEvent(record('dvr_task_backup', 'running', {
      providerId: 'anthropic',
      modelId: 'claude-sonnet-5',
      variant: 'high',
      attempt: 2,
      priorTaskId: 'dvr_task_limit',
      executionKind: 'retry_in_place',
      createdAt: 3_000,
    })).properties.task;

    const continued = renderView(
      <ManagedTaskRowView task={backup} priorEnvelope={envelope} onOpenChild={() => undefined} />,
    );
    expect(continued).toContain('Continued on claude-sonnet-5');
    expect(continued).toContain('after the usage limit');
    expect(continued).toContain('role="status"');

    const unrelated = renderView(
      <ManagedTaskRowView
        task={backup}
        priorEnvelope={{ ...envelope, autoResume: autoResumeBlock({ lastAttemptTaskId: 'dvr_task_other' }) }}
        onOpenChild={() => undefined}
      />,
    );
    expect(unrelated).not.toContain('after the usage limit');
  });

  test('renders a follow-up on its own when its prior task was compacted away', () => {
    const orphan = toManagedTaskEvent(record('dvr_task_orphan', 'running', {
      attempt: 2,
      priorTaskId: 'dvr_task_gone',
      executionKind: 'retry_in_place',
      createdAt: 3_000,
    })).properties.task;
    ingest(orphan);
    expect(store.getState().tasksById.dvr_task_orphan).toBeDefined();

    const html = renderView(<ManagedTaskRow taskId="dvr_task_orphan" />);

    expect(html).toContain('Map the Workspace');
    expect(html).toContain('Running...');
    expect(html).not.toContain('after the usage limit');
  });

  test('renders the auto-resume box from the envelope and toggles it through the store', () => {
    const { task, envelope } = manualRecoveryFailure('provider_usage_limit', autoResumeBlock());
    ingest(task, envelope);
    expect(store.getState().resultEnvelopesByTaskId.dvr_task_limit?.autoResume?.enabled).toBe(true);
    const calls: Array<[string, boolean]> = [];
    store.setState({
      setAutoResume: async (taskId: string, enabled: boolean) => { calls.push([taskId, enabled]); },
    });

    const html = renderView(<ManagedTaskRow taskId="dvr_task_limit" />);

    expect(html).toContain('Auto-Resume When the Limit Lifts');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('Try Again');
    expect(latestCheckboxChange).not.toBeNull();

    latestCheckboxChange?.(false);
    expect(calls).toEqual([['dvr_task_limit', false]]);
  });

  test('renders the box unchecked and off when the host sent no auto-resume block', () => {
    const { task, envelope } = manualRecoveryFailure('provider_usage_limit', null);

    const html = renderView(
      <ManagedTaskRowView
        task={task}
        resultEnvelope={envelope}
        onRetryInPlace={() => undefined}
        onAutoResumeChange={() => undefined}
        onOpenChild={() => undefined}
      />,
    );

    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('Auto-resume off');
    expect(html).toContain('Try Again');
  });

  test('does not offer auto-resume for manual recoveries that are not usage limits', () => {
    const { task, envelope } = manualRecoveryFailure('model_unavailable', autoResumeBlock());

    const html = renderView(
      <ManagedTaskRowView
        task={task}
        resultEnvelope={envelope}
        onRetryInPlace={() => undefined}
        onAutoResumeChange={() => undefined}
        onOpenChild={() => undefined}
      />,
    );

    expect(html).toContain('Try Again');
    expect(html).not.toContain('Auto-Resume');
    expect(html).not.toContain('role="checkbox"');
  });
});
