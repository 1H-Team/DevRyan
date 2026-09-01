import React from 'react';
import { createRoot } from 'react-dom/client';
import { SessionCreationStatus } from '@/components/chat/SessionCreationStatus';
import { beginCreationAttempt, updateCreationAttempt, useSessionCreationStore, forgetCreationAttempt } from '@/sync/session-creation';
import '../../packages/ui/src/index.css';

const draftId = 'visual-creation-draft';
const App = () => {
    const [text, setText] = React.useState(() => localStorage.getItem('creation-fixture-text') || 'Keep this draft and its synthetic attachment.');
    const attempt = useSessionCreationStore((state) => state.attempts[draftId]);
    const submit = () => {
        const nextAttempt = beginCreationAttempt({ draftId, text, directory: '/synthetic', providerID: 'fixture', modelID: 'fixture', planMode: false });
        updateCreationAttempt(nextAttempt, { phase: 'creating' });
    };
    return <main style={{ maxWidth: 800, padding: 32, margin: 'auto', color: '#222', background: '#fff', minHeight: '100vh' }}>
        <h1 style={{ fontSize: 24, marginBottom: 12 }}>Session creation — isolated verification</h1>
        <p style={{ marginBottom: 24 }}>Normal creation is silent; only retained-draft recovery states render above the composer.</p>
        <SessionCreationStatus draftId={draftId} onRetry={submit} />
        <textarea aria-label="Synthetic draft" value={text} onChange={(event) => { setText(event.target.value); localStorage.setItem('creation-fixture-text', event.target.value); }} style={{ width: '100%', minHeight: 100, border: '1px solid #aaa', padding: 12 }} />
        <p style={{ padding: 8 }}>Attachment retained: synthetic-notes.txt</p>
        <div style={{ display: 'flex', gap: 20, marginTop: 20 }}>
            <button disabled={Boolean(attempt && attempt.phase !== 'failed')} onClick={submit}>Start silent creation</button>
            <button disabled={!attempt} onClick={() => { if (attempt) updateCreationAttempt(attempt, { phase: 'unknown' }); }}>Mark outcome unknown</button>
            <button disabled={!attempt} onClick={() => { if (attempt) updateCreationAttempt(attempt, { phase: 'created', sessionId: 'ses_visual_acknowledged' }); }}>Record late-created outcome</button>
            <button onClick={() => { if (attempt) forgetCreationAttempt(attempt.draftId, attempt.id); }}>Reset fixture</button>
        </div>
        <p style={{ marginTop: 24 }}>Attempt phase: {attempt?.phase || 'none'}</p>
        <p id="selection">Original draft selected</p>
    </main>;
};
createRoot(document.getElementById('root')!).render(<App />);
