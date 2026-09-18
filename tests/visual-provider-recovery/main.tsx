import React from 'react';
import { createRoot } from 'react-dom/client';
import { createManagedTaskRecord, toManagedTaskEvent } from '../../packages/orchestration-runtime/index.js';
import { I18nProvider } from '@/lib/i18n';
import { ManagedTaskRowView } from '@/components/chat/ManagedTaskRow';
import { HostPrimaryRecovery } from '@/components/chat/HostPrimaryRecovery';
import { usePrimaryRecoveryStore } from '@/stores/usePrimaryRecoveryStore';
import { updateFixture, setOffline, setFixtureProvider, showRecoveredChild } from './fixture-api';
import '../../packages/ui/src/index.css';

const RecoveredResult = () => {
  const visible = usePrimaryRecoveryStore(state => Boolean(state.snapshots.ses_fixture?.record?.collectionIssue));
  const task = toManagedTaskEvent({ ...createManagedTaskRecord({ taskId: 'dvr_task_recovered', idempotencyKey: 'fixture',
    rootSessionId: 'ses_fixture', parentTaskId: null, directory: '/fixture', sequence: 1, mode: 'orchestrator',
    providerId: 'openai', modelId: 'fixture', agent: 'explorer', variant: 'medium', label: 'Review final changes',
    prompt: 'Review final changes', attempt: 1, priorTaskId: null, executionKind: 'start', createdAt: 1000, timeoutAt: null, readOnly: true }),
    status: 'completed', transportRecovery: { revision: 1, phase: 'recovered', kind: 'connection_failure',
      sameModelAttempts: 1, backupAttempts: 1, failedMessageId: 'msg_failed', failedUserMessageId: null,
      recoveryMessageId: 'msg_recovery', eventId: null, reservedAt: 1, submittedAt: 2 } }).properties.task;
  return visible ? <div className="chat-message-column"><section className="rounded-lg border border-border">
    <I18nProvider><ManagedTaskRowView task={task} providers={[{ id: 'openai', name: 'OpenAI',
      models: [{ id: 'fixture', name: 'GPT Recovery Fixture With A Deliberately Long Model Display Name' }] }]}
      onOpenChild={() => undefined} /></I18nProvider>
  </section></div> : null;
};

const App = () => <main style={{ maxWidth: 1200, padding: 24, margin: 'auto' }}>
  <h1 style={{ fontSize: 24, marginBottom: 12 }}>Provider recovery — isolated fixture</h1>
  <p style={{ marginBottom: 16 }}>No provider connection. Shared web and Electron component.</p>
  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 24 }}>
    <button onClick={() => setFixtureProvider('anthropic')}>Claude timeout</button>
    <button onClick={() => updateFixture('needs_attention', 'recovery_tool_outcome_unknown')}>Uncertain edit</button>
    <button onClick={() => updateFixture('reconciling')}>Check stopped state</button>
    <button onClick={() => updateFixture('recovering')}>Start recovery</button>
    <button onClick={() => updateFixture('needs_attention')}>Block unsafe action</button>
    <button onClick={() => updateFixture('observing', 'provider_input_progress_unavailable')}>Unobservable arguments</button>
    <button onClick={() => updateFixture('completed')}>Finish recovery</button>
    <button onClick={showRecoveredChild}>Recovered child, failed parent</button>
    <button onClick={() => setOffline(true)}>Disconnect</button>
    <button onClick={() => setOffline(false)}>Reconnect</button>
  </div>
  <p style={{ border: '1px solid #a55', padding: 12, marginBottom: 16 }}>Original error: The operation timed out. Completed tool work was preserved.</p>
  <HostPrimaryRecovery sessionId="ses_fixture" />
  <RecoveredResult />
</main>;
createRoot(document.getElementById('root')!).render(<App />);
