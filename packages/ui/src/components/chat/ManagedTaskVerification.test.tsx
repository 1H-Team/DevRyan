import React from 'react';
import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createManagedTaskRecord, toManagedTaskEvent } from '@devryan/orchestration-runtime';
import type { ManagedTaskProjectedRecord } from '@/lib/orchestrationApi';
import { I18nProvider } from '@/lib/i18n';
import { ManagedTaskVerification } from './ManagedTaskVerification';

const task = (): ManagedTaskProjectedRecord => ({
  ...toManagedTaskEvent(createManagedTaskRecord({ taskId: 'dvr_task_visual', idempotencyKey: 'visual',
    rootSessionId: 'root', parentTaskId: null, directory: '/fixture', sequence: 1, mode: 'orchestrator',
    providerId: 'fixture', modelId: 'fixture', agent: 'designer', variant: null, label: 'Visual check',
    prompt: 'Verify populated cards', attempt: 1, priorTaskId: null, executionKind: 'start',
    createdAt: 1, timeoutAt: null })).properties.task,
  verification: { objectiveId: 'implementation', ready: false, status: 'blocked', observedAt: 2,
    remaining: [{ name: 'Populated cards', status: 'blocked', reason: 'visual_report_missing' }],
    checks: [{ name: 'Populated cards', kind: 'visual', status: 'blocked', reason: 'visual_report_missing', evidence: null,
      coverage: { kind: 'declared-files', paths: ['src/cards.tsx'], contentHash: 'a'.repeat(64) } }] },
});
const render = (value: ManagedTaskProjectedRecord) => renderToStaticMarkup(<I18nProvider><ManagedTaskVerification task={value} /></I18nProvider>);

test('names the remaining requirement after execution and offers an explicit waiver', () => {
  const html = render({ ...task(), status: 'completed' });
  expect(html).toContain('Populated cards: Blocked');
  expect(html).toContain('Waive Remaining Checks');
  expect(html).not.toContain('Populated cards: Passed');
});

test('waived checks are distinguished from passing checks and cannot be waived twice', () => {
  const value = task();
  if (!value.verification) throw new Error('Missing fixture verification');
  value.verification = { ...value.verification, ready: true, status: 'waived', remaining: [],
    checks: value.verification.checks.map((check) => ({ ...check, status: 'waived' })) };
  const html = render(value);
  expect(html).toContain('Waived by user');
  expect(html).not.toContain('Waive Remaining Checks');
  expect(html).not.toContain('Populated cards: Passed');
});

test('verification purpose and integration prerequisites remain visible without claiming a pass', () => {
  const value = task();
  if (!value.verification) throw new Error('Missing fixture verification');
  value.verification = { ...value.verification, checks: value.verification.checks.map(check => ({ ...check, purpose: 'integration', prerequisites: ['Local API endpoint'] })) };
  const html = render(value);
  expect(html).toContain('(integration)');
  expect(html).toContain('Prerequisites: Local API endpoint');
  expect(html).toContain('Blocked');
  expect(html).not.toContain('Populated cards: Passed');
});

test('environment-unavailable checks say Skipped with the host hint and no waiver action', () => {
  const value = task();
  if (!value.verification) throw new Error('Missing fixture verification');
  value.verification = { ...value.verification, ready: true, status: 'skipped', remaining: [],
    checks: value.verification.checks.map(check => ({ ...check, status: 'skipped', reason: 'environment_unavailable',
      environmentUnavailable: { reason: 'docker_daemon_unavailable', hint: 'Start the Docker daemon and retry the check.' },
      evidence: { callId: 'call_check', messageId: 'msg_check', exitCode: 1, observedAt: 3, checkedContentHash: 'a'.repeat(64) } })) };
  const html = render({ ...value, status: 'completed' });
  expect(html).toContain('Populated cards: Skipped');
  expect(html).toContain('Start the Docker daemon and retry the check.');
  expect(html).not.toContain('Populated cards: Passed');
  expect(html).not.toContain('Pending evidence');
  expect(html).not.toContain('Waive Remaining Checks');
});
