import React, { act } from 'react';
import { expect, mock, test } from 'bun:test';
import { I18nProvider } from '@/lib/i18n';
import { withDom } from '@/test/mountedDom';
import { projectRequiredCheckCompletion, type RequiredCheckVerification } from '@devryan/orchestration-runtime';

let submit: ((checks: { name: string; contentHash: string }[], reason: string) => Promise<void>) | undefined;
const calls: unknown[] = [];
let objective = 'msg_objective';
const check = { name: 'unit', kind: 'command' as const, status: 'pending' as const, reason: 'check_not_observed',
  coverage: { kind: 'declared-files' as const, paths: ['source.ts'], contentHash: 'a'.repeat(64) }, evidence: null };
const verification = (): RequiredCheckVerification => ({ ...projectRequiredCheckCompletion([check]), objectiveId: objective, checks: [check], observedAt: 1 });
mock.module('@/lib/orchestrationApi', () => ({ managedOrchestrationApi: {
  getObjectiveVerification: async () => ({ objectiveId: objective, verification: verification() }),
  waiveObjectiveVerification: async (body: unknown) => { calls.push(body); },
} }));
mock.module('./ManagedTaskVerification', () => ({ VerificationDetails: (props: { verification: RequiredCheckVerification; submitWaiver: typeof submit }) => {
  submit = props.submitWaiver; return <div>{props.verification.checks[0]?.name}</div>;
} }));
const { ObjectiveVerification } = await import('./ObjectiveVerification');

test('shows the current root checks and sends only their exact objective and content hash on waiver', async () => {
  calls.length = 0; submit = undefined;
  await withDom(async container => {
    const { createRoot } = await import('react-dom/client'); const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(<I18nProvider><ObjectiveVerification sessionId="ses_root" directory="/project" revision="one" /></I18nProvider>));
      expect(container.textContent).toContain('unit');
      const section = container.find(node => node.attributes['data-objective-verification'] === objective);
      expect(section).not.toBeNull();
      expect(section?.attributes.class).toContain('chat-message-column');
      await act(async () => submit?.([{ name: 'unit', contentHash: 'a'.repeat(64) }], 'accepted limitation'));
      expect(calls).toEqual([{ rootSessionId: 'ses_root', directory: '/project', objectiveId: 'msg_objective',
        checks: [{ name: 'unit', contentHash: 'a'.repeat(64) }], reason: 'accepted limitation' }]);
      objective = 'msg_next';
      await act(async () => root.render(<I18nProvider><ObjectiveVerification sessionId="ses_root" directory="/project" revision="two" /></I18nProvider>));
      expect(container.find(node => node.attributes['data-objective-verification'] === 'msg_next')).not.toBeNull();
    } finally { await act(async () => root.unmount()); objective = 'msg_objective'; }
  });
});
