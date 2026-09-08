import React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import { SessionChangesCardView } from '@/components/chat/SessionChangesCard';
import { resolveSessionChangesFooterState } from '@/components/chat/sessionChangesController';
import { SessionChangesDiffDialog } from '@/components/chat/SessionChangesDiffDialog';
import '../../packages/ui/src/index.css';

// Only the network response and actions are simulated. Card, row, popover,
// confirmation, and revision-diff dialog are the production components.
let fixtureSegments = false;
opencodeClient.getSessionChangesDiffPage = async (_session, _directory, _revision, file, cursor, _signal, segment) => ({
    reviewMode: fixtureSegments ? 'segments' : 'net', segmentIndex: fixtureSegments ? segment ?? 0 : null, segmentCount: fixtureSegments ? 2 : 0,
    nextCursor: cursor ? null : 'second-page', previousCursor: null, pageIndex: cursor ? 1 : 0, totalBytes: 90_000,
    patch: cursor ? '+last recorded line\n' : `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old value\n+recorded session value ${fixtureSegments ? (segment ?? 0) + 1 : ''}\n` + '+recorded detail\n'.repeat(3000),
});
function Fixture() {
    const [segmented, setSegmented] = React.useState(false);
    const [siblingWorking, setSiblingWorking] = React.useState(false);
    const [session, setSession] = React.useState('A');
    const [undone, setUndone] = React.useState(false);
    const [summaryState, setSummaryState] = React.useState<'ready' | 'loading' | 'failed' | 'empty-partial'>('ready');
    const [contentChanges, setContentChanges] = React.useState(0);
    const onContentChange = React.useCallback(() => setContentChanges((count) => count + 1), []);
    const [planning, setPlanning] = React.useState(false);
    const [working, setWorking] = React.useState(false);
    const [empty, setEmpty] = React.useState(false);
    const [partial, setPartial] = React.useState(false);
    const [selected, setSelected] = React.useState<string | null>(null);
    const [mobile, setMobile] = React.useState(false);
    const [large, setLarge] = React.useState(false);
    const [pageIndex, setPageIndex] = React.useState(0);
    const files = (large ? Array.from({ length: Math.min(128, 513 - pageIndex * 128) }, (_, i) => `src/generated-${String(pageIndex * 128 + i).padStart(5, '0')}.ts`) : session === 'child' ? ['src/child.ts'] : session === 'A' ? ['src/app.ts', 'src/theme.css', 'assets/icon.png', 'tests/app.test.ts'] : ['src/calendar.ts']).map((file, index) => ({
        path: `/fixture/${file}`, relativePath: file, insertions: index === 2 ? 0 : 5, deletions: index === 2 ? 0 : 2, status: 'M', binary: index === 2, reviewMode: segmented ? 'segments' as const : 'net' as const, segmentCount: segmented ? 2 : 0,
    }));
    const visibleFiles = undone || empty || summaryState === 'empty-partial' ? [] : files;
    const state = resolveSessionChangesFooterState({
        isGitRepo: true, fileCount: visibleFiles.length, isUndone: undone,
        isRevertPending: false, isTreeWorking: working, isSiblingWorking: siblingWorking,
        isImplementationSettled: !planning && !working,
    });
    return <main style={{ maxWidth: mobile ? 390 : 900, margin: 'auto', padding: 24, minHeight: '100vh' }}>
        <h1 className="mb-4 text-xl font-semibold">Session changes — isolated verification</h1>
        <nav className="mb-8 flex flex-wrap gap-4">
            <button onClick={() => { setSession(session === 'A' ? 'B' : 'A'); setSelected(null); setUndone(false); }}>Switch session</button>
            <button onClick={() => { setSession('child'); setSelected(null); }}>Select child only</button>
            <button onClick={() => { fixtureSegments = !segmented; setSegmented(!segmented); setSelected(null); }}>Toggle recorded segments</button>
            <button onClick={() => setSiblingWorking(!siblingWorking)}>Toggle independent session working</button>
            <button onClick={() => setPlanning(!planning)}>Toggle submitted plan mode</button>
            <button onClick={() => setWorking(!working)}>Toggle working</button>
            <button onClick={() => setEmpty(!empty)}>Toggle empty capture</button>
            <button onClick={() => setPartial(!partial)}>Toggle incomplete</button>
            <button onClick={() => setSummaryState('loading')}>Loading summary</button>
            <button onClick={() => setSummaryState('failed')}>Failed summary</button>
            <button onClick={() => setSummaryState('empty-partial')}>Empty incomplete summary</button>
            <button onClick={() => setSummaryState('ready')}>Complete capture</button>
            <button onClick={() => setMobile(!mobile)}>Toggle mobile</button>
            <button onClick={() => { setLarge(!large); setPageIndex(0); }}>Toggle large capture</button>
        </nav>
        <p>{siblingWorking ? 'Independent session B continues working. ' : ''}{planning ? 'Plan presented' : working ? 'Implementation in progress' : 'Implementation completed'} for session {session}.</p>
        {state.visible && <SessionChangesCardView key={session} directory="/fixture" files={visibleFiles} subagentCount={session === 'A' ? 1 : 0}
            totalsMode={segmented ? 'recorded' : 'net'} fileCount={large ? 513 : visibleFiles.length} pageIndex={pageIndex}
            onNextPage={large && pageIndex < 4 ? () => setPageIndex(pageIndex + 1) : undefined}
            onPreviousPage={large && pageIndex > 0 ? () => setPageIndex(pageIndex - 1) : undefined}
            mode={undone ? 'undone' : 'changes'} undoDisabled={partial || segmented || siblingWorking || summaryState !== 'ready'} disabledReason={partial ? 'Some tools lack verified edit receipts.' : segmented ? 'Review recorded edits individually; safe Undo is unavailable.' : siblingWorking ? 'Another session is working.' : null} busy={null} isMobile={mobile}
            onContentChange={onContentChange}
            onRetry={summaryState === 'failed' ? () => setSummaryState('ready') : undefined}
            statusMessage={summaryState === 'loading' ? 'Loading session changes…' : summaryState === 'failed' ? 'Session changes could not be loaded.' : summaryState === 'empty-partial' ? 'Some session changes could not be captured.' : partial ? 'Some tools lack verified edit receipts. Known edits remain available for review.' : null}
            onUndo={() => setUndone(true)} onRedo={() => setUndone(false)} onOpenFile={(file) => setSelected(file.path.replace('/fixture/', ''))} />}
        <output className="mt-4 block text-sm">Structural updates: {contentChanges}</output>
        {selected ? <SessionChangesDiffDialog rootSessionID={session} directory="/fixture" revision="fixture-revision" file={selected} onClose={() => setSelected(null)} /> : null}
    </main>;
}
createRoot(document.getElementById('root')!).render(<I18nProvider><Fixture /></I18nProvider>);
