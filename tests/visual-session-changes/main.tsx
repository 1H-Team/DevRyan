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
            <button onClick={() => setMobile(!mobile)}>Toggle mobile</button>
        </nav>
        <p>Implementation completed for session {session}.</p>
        <SessionChangesCardView key={session} directory="/fixture" files={undone ? [] : files} subagentCount={session === 'A' ? 1 : 0}
            mode={undone ? 'undone' : 'changes'} undoDisabled={partial} disabledReason={partial ? 'Overlapping owners' : null} busy={null} isMobile={mobile}
            statusMessage={partial ? 'Some changes have overlapping owners and remain unassigned.' : null}
            onUndo={() => setUndone(true)} onRedo={() => setUndone(false)} onOpenFile={(file) => setSelected(file.path.replace('/fixture/', ''))} />
        {selected ? <SessionChangesDiffDialog rootSessionID={session} directory="/fixture" revision="fixture-revision" file={selected} onClose={() => setSelected(null)} /> : null}
    </main>;
}
createRoot(document.getElementById('root')!).render(<I18nProvider><Fixture /></I18nProvider>);
