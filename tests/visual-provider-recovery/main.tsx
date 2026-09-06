import React from 'react';
import { createRoot } from 'react-dom/client';
import { HostPrimaryRecovery } from '@/components/chat/HostPrimaryRecovery';
import { updateFixture, setOffline } from './fixture-api';
import '../../packages/ui/src/index.css';

const App = () => <main style={{ maxWidth: 760, padding: 24, margin: 'auto' }}>
  <h1 style={{ fontSize: 24, marginBottom: 12 }}>Provider recovery — isolated fixture</h1>
  <p style={{ marginBottom: 16 }}>No provider connection. Shared web and Electron component.</p>
  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 24 }}>
    <button onClick={() => updateFixture('reconciling')}>Check stopped state</button>
    <button onClick={() => updateFixture('recovering')}>Start recovery</button>
    <button onClick={() => updateFixture('needs_attention')}>Block unsafe action</button>
    <button onClick={() => updateFixture('observing', 'provider_input_progress_unavailable')}>Unobservable arguments</button>
    <button onClick={() => updateFixture('completed')}>Finish recovery</button>
    <button onClick={() => setOffline(true)}>Disconnect</button>
    <button onClick={() => setOffline(false)}>Reconnect</button>
  </div>
  <p style={{ border: '1px solid #a55', padding: 12, marginBottom: 16 }}>Original error: The operation timed out. Completed tool work was preserved.</p>
  <HostPrimaryRecovery sessionId="ses_fixture" />
</main>;
createRoot(document.getElementById('root')!).render(<App />);
