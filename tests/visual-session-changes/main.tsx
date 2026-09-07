import React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import { SessionChangesCardView } from '@/components/chat/SessionChangesCard';
import { SessionChangesDiffDialog } from '@/components/chat/SessionChangesDiffDialog';
import '../../packages/ui/src/index.css';

// Only the network response and actions are simulated. Card, row, popover,
// confirmation, and revision-diff dialog are the production components.
opencodeClient.getSessionChangesDiff = async (_session, _directory, _revision, file) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old value\n+recorded session value\n`;
function Fixture() {
    const [session, setSession] = React.useState('A');
    const [undone, setUndone] = React.useState(false);
    const [summaryState, setSummaryState] = React.useState<'ready' | 'loading' | 'failed' | 'empty-partial'>('ready');
    const [contentChanges, setContentChanges] = React.useState(0);
    const onContentChange = React.useCallback(() => setContentChanges((count) => count + 1), []);
    const [partial, setPartial] = React.useState(false);
    const [selected, setSelected] = React.useState<string | null>(null);
    const [mobile, setMobile] = React.useState(false);
    const files = (session === 'A' ? ['src/app.ts', 'src/theme.css', 'assets/icon.png', 'tests/app.test.ts'] : ['src/calendar.ts']).map((file, index) => ({
        path: `/fixture/${file}`, relativePath: file, insertions: index === 2 ? 0 : 5, deletions: index === 2 ? 0 : 2, status: 'M', binary: index === 2,
    }));
    return <main style={{ maxWidth: mobile ? 390 : 900, margin: 'auto', padding: 24, minHeight: '100vh' }}>
        <h1 className="mb-4 text-xl font-semibold">Session changes — isolated verification</h1>
        <nav className="mb-8 flex flex-wrap gap-4">
            <button onClick={() => { setSession(session === 'A' ? 'B' : 'A'); setSelected(null); setUndone(false); }}>Switch session</button>
            <button onClick={() => setPartial(!partial)}>Toggle incomplete</button>
            <button onClick={() => setSummaryState('loading')}>Loading summary</button>
            <button onClick={() => setSummaryState('failed')}>Failed summary</button>
            <button onClick={() => setSummaryState('empty-partial')}>Empty incomplete summary</button>
            <button onClick={() => setSummaryState('ready')}>Complete capture</button>
            <button onClick={() => setMobile(!mobile)}>Toggle mobile</button>
        </nav>
        <p>Implementation completed for session {session}.</p>
        <SessionChangesCardView key={session} directory="/fixture" files={undone || summaryState !== 'ready' ? [] : files} subagentCount={session === 'A' ? 1 : 0}
            mode={undone ? 'undone' : 'changes'} undoDisabled={partial || summaryState !== 'ready'} disabledReason={partial ? 'Overlapping owners' : null} busy={null} isMobile={mobile}
            onContentChange={onContentChange}
            onRetry={summaryState === 'failed' ? () => setSummaryState('ready') : undefined}
            statusMessage={summaryState === 'loading' ? 'Loading session changes…' : summaryState === 'failed' ? 'Session changes could not be loaded.' : summaryState === 'empty-partial' ? 'Some session changes could not be captured.' : partial ? 'Some changes have overlapping owners and remain unassigned.' : null}
            onUndo={() => setUndone(true)} onRedo={() => setUndone(false)} onOpenFile={(file) => setSelected(file.path.replace('/fixture/', ''))} />
        <output className="mt-4 block text-sm">Structural updates: {contentChanges}</output>
        {selected ? <SessionChangesDiffDialog rootSessionID={session} directory="/fixture" revision="fixture-revision" file={selected} onClose={() => setSelected(null)} /> : null}
    </main>;
}
createRoot(document.getElementById('root')!).render(<I18nProvider><Fixture /></I18nProvider>);
