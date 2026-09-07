import React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { InProgressOperationBanner } from '@/components/views/git/InProgressOperationBanner';
import { SyncActions } from '@/components/views/git/SyncActions';
import { CommitSection } from '@/components/views/git/CommitSection';
import '../../packages/ui/src/index.css';

function Fixture() {
  const [active, setActive] = React.useState(true);
  const [conflicts, setConflicts] = React.useState(true);
  const [message, setMessage] = React.useState('fix: preserve branch changes');
  const [pushed, setPushed] = React.useState(false);
  const remotes = [{ name: 'origin', fetchUrl: 'fixture', pushUrl: 'fixture' }];
  return <main style={{ maxWidth: 720, margin: 'auto', padding: 24 }}>
    <h1 className="text-xl mb-4">Git recovery</h1>
    <p className="mb-4">{active ? 'Dev rebase paused' : 'Dev ready to push'}{pushed ? ' · Push invoked' : ''}</p>
    <button className="underline mb-4" onClick={() => setConflicts(false)}>Mark fixture conflicts resolved</button>
    <SyncActions syncAction={null} remotes={remotes} onFetch={() => {}} onPull={() => {}} onPush={() => setPushed(true)} onRefresh={() => {}} disabled={false} remoteActionsDisabled={active} aheadCount={2} behindCount={0} />
    <InProgressOperationBanner mergeInProgress={null} rebaseInProgress={active ? { headName: 'Dev', onto: '6e9e932' } : null}
      hasUnresolvedConflicts={conflicts} onContinue={async () => setActive(false)} onAbort={async () => setActive(false)} onResolveWithAI={() => {}} />
    <div className="mt-6"><CommitSection selectedCount={1} commitMessage={message} onCommitMessageChange={setMessage}
      onCommit={() => {}} onCommitAmend={() => {}} onCommitAndPush={() => setPushed(true)} onCommitAndSync={() => setPushed(true)}
      onGenerateCommitMessage={() => {}} commitAction={null} isGeneratingCommitMessage={false} commitGenerationDisabled={false}
      gitmojiEnabled={false} onOpenGitmojiPicker={() => {}} syncAction={null} remotes={remotes} onSync={() => {}} syncDisabled={active} /></div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<I18nProvider><Fixture /></I18nProvider>);
