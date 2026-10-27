import React, { act } from 'react';
import { expect, mock, test } from 'bun:test';
import { createManagedTaskRecord, toManagedTaskEvent } from '@devryan/orchestration-runtime';
import { withDom } from '@/test/mountedDom';
import { useConfigStore } from '@/stores/useConfigStore';
import { useConfigApplyStore } from '@/stores/useConfigApplyStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useManagedOrchestrationStore } from '@/stores/useManagedOrchestrationStore';
import {
    beginRuntimeCapabilityRead, observeRuntimeCapabilityHealth, resetRuntimeCapabilitiesForTests,
} from '@/lib/opencode/runtime-capabilities';

const sync = { ...(await import('@/sync/sync-context')) };
mock.module('@/sync/sync-context', () => ({
    ...sync,
    useSyncChildStores: () => ({ getChild: () => undefined }),
    useSyncResyncSession: () => async () => undefined,
    useSessionRevertPending: () => false,
}));
mock.module('@/hooks/useAssistantStatus', () => ({ useAssistantStatus: () => ({
    currentPromptId: 'msg_parent',
    working: { isWorking: false, statusText: null, isGenericStatus: false },
}) }));
mock.module('./StatusRow', () => ({ StatusRow: ({ statusText, isWorking }: {
    statusText?: string | null; isWorking?: boolean;
}) => <span>{isWorking ? statusText : 'Idle'}</span> }));
const { I18nProvider } = await import('@/lib/i18n');
const { StatusRowContainer } = await import('./StatusRowContainer');

test('native failure replaces stale managed activity even while SSE is connected, and recovery restores authoritative status', async () => {
    const previousFetch = globalThis.fetch;
    const health = { openCode: { generation: 2 }, isOpenCodeReady: false };
    globalThis.fetch = mock(async () => Response.json(health));
    resetRuntimeCapabilitiesForTests();
    useConfigStore.setState({ isConnected: true });
    useSessionUIStore.setState({ currentSessionId: 'ses_runtime_health' });
    let retries = 0;
    useConfigApplyStore.setState({ isRequesting: false, requestError: null,
        status: { revision: 2, appliedRevision: 1, state: 'failed', pending: true, scopes: ['agents'],
            reasonCodes: [], activeSessionCount: 0, runtimeMode: 'managed', canApplyWhenIdle: true,
            canForceRestart: true },
        applyWhenIdle: async () => { retries++; return null; },
    });
    const task = { ...createManagedTaskRecord({
        taskId: 'dvr_task_runtime_health', idempotencyKey: 'health', rootSessionId: 'ses_runtime_health',
        parentTaskId: null, directory: '/fixture', sequence: 1, mode: 'orchestrator', dispatchGroupId: 'msg_parent',
        providerId: 'cursor-acp', modelId: 'fixture-model', agent: 'explorer', variant: 'medium',
        label: 'Inspect fixture', prompt: 'Inspect the fixture.', attempt: 2, priorTaskId: null,
        executionKind: 'resume', createdAt: 1_000, timeoutAt: null,
    }), status: 'running' as const, childSessionId: 'ses_child', startedAt: 2_000 };
    useManagedOrchestrationStore.getState().ingestEvent(toManagedTaskEvent(task));
    try {
        await withDom(async container => {
            const { createRoot } = await import('react-dom/client');
            const root = createRoot(container as unknown as Element);
            try {
                await act(async () => root.render(<I18nProvider><StatusRowContainer /></I18nProvider>));
                expect(container.textContent).toContain('OpenCode is unavailable');
                expect(container.textContent).not.toContain('Waiting for subagent output');
                expect(useConfigStore.getState().isConnected).toBe(true);
                await act(async () => { container.find(node => node.tagName === 'BUTTON')?.click(); });
                expect(retries).toBe(1);
                await act(async () => {
                    observeRuntimeCapabilityHealth({ ...health, isOpenCodeReady: true }, beginRuntimeCapabilityRead());
                });
                expect(container.textContent).toContain('Waiting for subagent output');
                await act(async () => {
                    useManagedOrchestrationStore.getState().ingestEvent(toManagedTaskEvent({ ...task,
                        status: 'interrupted', finishedAt: 3_000, failureReason: 'Runtime stopped' }));
                });
                expect(container.textContent).not.toContain('Waiting for subagent output');
            } finally { await act(async () => root.unmount()); }
        });
    } finally { globalThis.fetch = previousFetch; resetRuntimeCapabilitiesForTests(); }
});
