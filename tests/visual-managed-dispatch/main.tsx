import React from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from 'zustand';
import { createManagedTaskRecord, toManagedTaskEvent } from '@devryan/orchestration-runtime';
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
const name = 'Feedback Chat Greeting and Form';
const fixerSession = { id: fixerRecord.childSessionId, title: 'Verify and Stabilize Guest Chat Geometry' };
const setTitle = (title: string) => fixtureSessions.setState({ session: [{ id: record.childSessionId, title }, fixerSession] });
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
