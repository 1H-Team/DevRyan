import { usePrimaryRecoveryStore } from '@/stores/usePrimaryRecoveryStore';
import React, { act } from 'react';
import { beforeEach, expect, test } from 'bun:test';
import { useNotificationStore } from '@/sync/notification-store';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import { withDom } from '../bots/chat/botMountedDom';
import { SessionFailureNotice } from './SessionFailureNotice';

beforeEach(() => {
  useNotificationStore.setState({ list: [] });
  usePrimaryRecoveryStore.setState({ snapshots: {} });
});

test('a viewed failure without an assistant stays visible, persists safely, and clears only on newer completion', async () => {
  await withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    const now = Date.now();
    await act(async () => {
      useNotificationStore.getState().append({ type: 'error', session: 's', viewed: true, time: now,
        error: { name: 'UnknownError', data: { message: 'TimeoutError: The operation timed out.\nprivate stack' } } });
      root.render(<SessionFailureNotice sessionId="s" />);
    });
    expect(container.find((node) => node.getAttribute('role') === 'alert')).not.toBeNull();
    const persisted = getSafeStorage().getItem('openchamber:notification-completions:v1') ?? '';
    expect(persisted).toContain('session_timeout');
    expect(persisted).not.toContain('private stack');
    const errors = useNotificationStore.getState().list;
    await act(async () => useNotificationStore.getState().resolveErrors(errors, 'older', now - 1));
    expect(container.find((node) => node.getAttribute('role') === 'alert')).not.toBeNull();
    await act(async () => root.render(<SessionFailureNotice sessionId="other" />));
    expect(container.find((node) => node.getAttribute('role') === 'alert')).toBeNull();
    await act(async () => {
      root.render(<SessionFailureNotice sessionId="s" />);
      useNotificationStore.getState().resolveErrors(errors, 'newer', now + 1);
    });
    expect(container.find((node) => node.getAttribute('role') === 'alert')).toBeNull();
    await act(async () => root.unmount());
  });
});


test('a durable unsupported-provider failure is visible when the original event was missed', async () => {
  await withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    const record = { sessionID: 's', anchorID: 'u', failedID: null, recoveryID: null, state: 'observing',
      revision: 1, attemptCount: 0, maxAttempts: 1, readOnly: false, providerID: 'xai', modelID: 'grok-4.6',
      agent: 'builder', variant: 'high', reason: null, updatedAt: 1000, failureObserved: true };
    const snapshot = { schemaVersion: 1, mode: 'observe', supported: false, enforced: false, progressTimeoutMs: 300000, record };
    try {
      await act(async () => {
        usePrimaryRecoveryStore.getState().accept('s', snapshot);
        root.render(<SessionFailureNotice sessionId="s" />);
      });
      expect(container.textContent).toContain('Request failed');
      await act(async () => usePrimaryRecoveryStore.getState().accept('s', { ...snapshot,
        record: { ...record, anchorID: 'new-user', updatedAt: 2000, revision: 2, failureObserved: false } }));
      expect(container.find((node) => node.getAttribute('role') === 'alert')).toBeNull();
    } finally { await act(async () => root.unmount()); }
  });
});

test('explicit user cancellation is not presented as a failed request', async () => {
  await withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => {
        useNotificationStore.getState().append({ type: 'error', session: 's', time: Date.now(), viewed: true,
          error: { name: 'MessageAbortedError' } });
        root.render(<SessionFailureNotice sessionId="s" />);
      });
      expect(container.find((node) => node.getAttribute('role') === 'alert')).toBeNull();
      expect(getSafeStorage().getItem('openchamber:notification-completions:v1')).toContain('session_cancelled');
    } finally { await act(async () => root.unmount()); }
  });
});
