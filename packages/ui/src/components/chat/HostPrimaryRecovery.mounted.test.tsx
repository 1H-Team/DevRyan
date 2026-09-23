import React, { act } from 'react';
import { expect, mock, test } from 'bun:test';
import { usePrimaryRecoveryStore, type PrimaryRecoverySnapshot } from '@/stores/usePrimaryRecoveryStore';
import { withDom } from '../bots/chat/botMountedDom';

const requests: unknown[][] = [];
let respond: () => Promise<void> = async () => {};
mock.module('@/lib/primaryRecoveryApi', () => ({ requestPrimaryRecovery: (...args: unknown[]) => {
  requests.push(args); return respond();
} }));
const { HostPrimaryRecovery } = await import('./HostPrimaryRecovery');
const snapshot = (): PrimaryRecoverySnapshot => ({ schemaVersion: 1, mode: 'enforce', supported: true, enforced: true,
  progressTimeoutMs: 300_000, record: { sessionID: 'ses_root', anchorID: 'msg_user', failedID: null, recoveryID: null,
    state: 'observing', revision: 2, attemptCount: 0, maxAttempts: 1, readOnly: false,
    providerID: 'openai', modelID: 'gpt-fixture', agent: 'orchestrator', variant: null, reason: null, updatedAt: 100,
    collectionIssue: { taskId: 'dvr_task_recovered', code: 'managed_continuation_fenced' } } });

test('offers an explicit collection for a fenced sub-agent result and recovers on projection changes', async () => {
  requests.length = 0;
  respond = async () => {};
  await withDom(async container => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    try {
      usePrimaryRecoveryStore.setState({ snapshots: { ses_root: snapshot() } });
      await act(async () => root.render(<HostPrimaryRecovery sessionId="ses_root" showAvailability />));
      expect(container.textContent).toContain('Sub-agent result ready');
      expect(container.textContent).not.toContain('managed_continuation_fenced');
      expect(requests).toEqual([['ses_root']]);
      await act(async () => { container.find(node => node.tagName === 'BUTTON' && node.textContent === 'Collect Result')?.click(); });
      expect(requests[1].slice(0, 2)).toEqual(['ses_root', 'continue']);
      requests.splice(1);
      const changed = snapshot();
      changed.record!.collectionIssue = null;
      changed.record!.state = 'needs_attention';
      changed.record!.revision++;
      await act(async () => { usePrimaryRecoveryStore.getState().accept('ses_root', changed); });
      expect(container.textContent).toContain('Recovery needs your attention');
      expect(container.textContent).toContain('Continue with original permissions');
      expect(container.textContent).not.toContain('gpt-fixture');
      expect(container.textContent).not.toContain('orchestrator');
      await act(async () => { container.find(node => node.tagName === 'BUTTON' && node.textContent === 'Continue with original permissions')?.click(); });
      expect(requests[1].slice(0, 2)).toEqual(['ses_root', 'continue']);
      expect(/^msg_[a-zA-Z0-9]+$/.test(String(requests[1][2]))).toBe(true);
      await act(async () => { container.find(node => node.tagName === 'BUTTON' && node.textContent === 'Stop')?.click(); });
      expect(requests[2].slice(0, 2)).toEqual(['ses_root', 'cancel']);
    } finally { await act(async () => root.unmount()); usePrimaryRecoveryStore.setState({ snapshots: {} }); }
  });
});
