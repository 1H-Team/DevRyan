import React from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from 'zustand';
import { createManagedTaskRecord, createManagedTaskResultEnvelope, toManagedTaskEvent, projectRequiredCheckEvidence, projectRequiredCheckCompletion, type RequiredCheck, type RequiredCheckReceipt } from '@devryan/orchestration-runtime';
import { managedOrchestrationApi } from '@/lib/orchestrationApi';
import { ManagedTaskList } from '@/components/chat/ManagedTaskList';
import { useManagedOrchestrationStore } from '@/stores/useManagedOrchestrationStore';
import { I18nProvider } from '@/lib/i18n';
import { resolveDisplaySessionTitle } from '@/lib/sessionTitles';
import { fixtureSessions } from './fixture-sync';
import '../../packages/ui/src/index.css';

const record = { ...createManagedTaskRecord({ taskId: 'dvr_task_visual', idempotencyKey: 'visual', rootSessionId: 'ses_visual', parentTaskId: null, directory: '/fixture', sequence: 1, mode: 'orchestrator', providerId: 'openai', modelId: 'gpt-6-astra', agent: 'designer', variant: null, label: 'Managed designer task', prompt: 'Implement approved plan: Feedback Chat Greeting and Form.', attempt: 1, priorTaskId: null, executionKind: 'start', createdAt: 1000, timeoutAt: null }), childSessionId: 'ses_visual_child', status: 'running' as const, startedAt: 1100, dispatchCallId: 'call_visual' };
useManagedOrchestrationStore.getState().ingestEvent(toManagedTaskEvent(record));
// A second agent group shows the spacing between the card header, agent labels and rows.
const fixerRecord = { ...createManagedTaskRecord({ taskId: 'dvr_task_visual_fixer', idempotencyKey: 'visual-fixer', rootSessionId: 'ses_visual', parentTaskId: null, directory: '/fixture', sequence: 2, mode: 'orchestrator', providerId: 'openai', modelId: 'gpt-6-astra', agent: 'fixer', variant: null, label: 'Managed fixer task', prompt: 'Verify and stabilize guest chat geometry.', attempt: 1, priorTaskId: null, executionKind: 'start', createdAt: 1000, timeoutAt: null }), childSessionId: 'ses_visual_fixer_child', status: 'running' as const, startedAt: 1100, dispatchCallId: 'call_visual_fixer' };
useManagedOrchestrationStore.getState().ingestEvent(toManagedTaskEvent(fixerRecord));
const visualChecks: RequiredCheck[] = [{ name: 'Populated image cards', command: 'bun test visual-cards.test.ts', paths: ['src/cards.tsx'],
  kind: 'visual', visual: { state: 'populated', dataSource: 'fixture', assertions: ['Three cards show images and captions'], reportPath: 'visual-report.json' } }];
const verificationRecord = { ...record, taskId: 'dvr_task_visual_verification', sequence: 3, childSessionId: 'ses_verification',
  dispatchCallId: 'call_verification', label: 'Verify populated image cards', status: 'completed' as const, finishedAt: 1200, requiredChecks: visualChecks };
let fixtureHash = 'a'.repeat(64);
const verificationEnvelope = createManagedTaskResultEnvelope(verificationRecord, { sequence: 4, createdAt: 1200, resumable: false });
let fixtureObservation = 1300;
let visualReceipt: RequiredCheckReceipt = { name: visualChecks[0].name, callId: 'call_verify', messageId: 'msg_verify',
  exitCode: 0, contentHash: fixtureHash, status: 'blocked', observedAt: fixtureObservation };
const verificationTask = () => {
  const checks = projectRequiredCheckEvidence(visualChecks, [visualReceipt], { [visualChecks[0].name]: fixtureHash });
  return { ...toManagedTaskEvent(verificationRecord).properties.task, verification: {
    ...projectRequiredCheckCompletion(checks), checks, objectiveId: 'msg_implementation', observedAt: ++fixtureObservation,
  } };
};
const publishVerification = () => {
  const event = toManagedTaskEvent(verificationRecord, verificationEnvelope);
  useManagedOrchestrationStore.getState().ingestEvent({ ...event, properties: { ...event.properties, task: verificationTask() } });
};
publishVerification();
// This fixture simulates only the HTTP response. Auth and receipt authority are
// qualified separately by server tests; no runtime or provider is connected.
managedOrchestrationApi.getSnapshot = async () => ({ available: true, bridgeReady: true, recoveryWarning: null,
  tasks: [toManagedTaskEvent(record).properties.task, toManagedTaskEvent(fixerRecord).properties.task, verificationTask()], resultEnvelopes: [verificationEnvelope] });
managedOrchestrationApi.waiveVerification = async (_taskId, input) => {
  if (!input.reason.trim() || input.checks[0]?.contentHash !== fixtureHash) throw new Error('Fixture waiver requires a reason and current content');
  visualReceipt = { ...visualReceipt, status: 'waived', messageId: null, exitCode: null, observedAt: ++fixtureObservation,
    waiver: { source: 'authenticated-user', userId: 'fixture-human', reason: input.reason } };
  publishVerification();
  return { taskId: verificationRecord.taskId, verification: verificationTask().verification };
};
const name = 'Feedback Chat Greeting and Form';
const fixerSession = { id: fixerRecord.childSessionId, title: 'Verify and Stabilize Guest Chat Geometry' };
const verificationSession = { id: verificationRecord.childSessionId, title: 'Verify Populated Image Cards' };
const setTitle = (title: string) => fixtureSessions.setState({ session: [{ id: record.childSessionId, title }, fixerSession, verificationSession] });
setTitle('Managed designer task');
export const App = () => {
  const title = useStore(fixtureSessions, (state) => state.session[0].title);
  return <I18nProvider><main style={{ maxWidth: 900, padding: 20, margin: 'auto' }}>
    <h1 style={{ fontSize: 22 }}>Implementation startup fixture</h1>
    <p>Isolated shared UI. No provider or runtime connection.</p>
    <nav style={{ display: 'flex', gap: 16, flexWrap: 'wrap', margin: '20px 0' }}>
      <button onClick={() => setTitle('Managed designer task')}>Reset title</button>
      <button onClick={() => setTitle(name)}>Deliver title</button>
      <button onClick={() => { setTitle('Managed designer task'); window.setTimeout(() => setTitle(name), 3000); }}>Delay title 3s</button>
      <button onClick={() => setTitle('My feedback task')}>Rename child</button>
      <button onClick={() => window.setTimeout(() => { fixtureHash = 'b'.repeat(64); publishVerification(); }, 2000)}>Change source after 2s</button>
    </nav>
    <aside style={{ padding: 12, border: '1px solid var(--surface-border)', marginBottom: 24 }} data-sidebar-title>
      {resolveDisplaySessionTitle({ title, fallback: 'Untitled Session' })}
    </aside>
    <section aria-label="Implementation transcript">
      <p style={{ margin: '16px 0' }}>I will implement the feedback-only change and verify the greeting and form.</p>
      <ManagedTaskList rootSessionId="ses_visual" />
    </section>
  </main></I18nProvider>;
};
createRoot(document.getElementById('root')!).render(<App />);
