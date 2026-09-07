import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { I18nProvider } from '@/lib/i18n';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { useUserMessageHistory } from '@/sync/sync-context';
import { INITIAL_STATE } from '@/sync/types';
import { buildUserMessageHistory } from '@/sync/user-message-history';
import { useUIStore } from '@/stores/useUIStore';
import MessageBody from '@/components/chat/message/MessageBody';
import ToolPart from '@/components/chat/message/parts/ToolPart';
import { RawPatchFallback } from '@/components/chat/message/parts/RawPatchFallback';
import { getMessageCopyText } from '@/lib/messages/messageCopyText';
import { copyTextToClipboard } from '@/lib/clipboard';
import { createWebAPIs } from '../../packages/web/src/api';
import '../../packages/ui/src/index.css';
import './style.css';

const text = (id, value, messageID = 'user') => ({ id, messageID, sessionID: 'session', type: 'text', text: value });
const info = (id, role = 'user') => ({ id, sessionID: 'session', role, time: { created: 1 } });
const store = createStore(() => ({ ...INITIAL_STATE,
    message: { session: [info('user'), info('assistant', 'assistant')] },
    part: { user: [text('p', 'Initial prompt')], assistant: [] },
}));
const otherStore = createStore(() => ({ ...INITIAL_STATE, message: { session: [info('user')] }, part: { user: [text('p', 'Other directory')] } }));
const childStores = {
    children: new Map([['/fixture', store], ['/other', otherStore]]),
    ensureChild: (directory) => directory === '/other' ? otherStore : store,
    getChild: (directory) => directory === '/other' ? otherStore : store,
    subscribeSessionLists: (notify) => store.subscribe(notify),
};
// The production module shares this context across chunks. Supply only isolated fixture state.
const FixtureSyncContext = globalThis.__openchamber_sync_context__;
const sync = { childStores, directory: '/fixture' };
const counts = { history: 0, broad: 0 };
const huge = '--- a/example.txt\r\n+++ b/example.txt\r\n@@ -1 +1 @@\r\n-old\r\n+' + 'x'.repeat(262144) + '\r\nFULL SOURCE TAIL\r\n';
const write = 'new file line\r\n'.repeat(2100);
const markdown = '  paragraph\r\n\r\n```ts\r\n  const x = 1;\r\n```\r\n\r\n    indented code\r\n';
const sourceOperations = { split: 0, replace: 0, trim: 0 };
for (const method of ['split', 'replace', 'trim']) {
    const original = String.prototype[method];
    String.prototype[method] = function (...args) {
        if (String(this) === huge || String(this) === write) sourceOperations[method] += 1;
        return original.apply(this, args);
    };
}
let clipboard = '';
let denyClipboard = false;
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async (value) => { if (denyClipboard) throw new Error('Fixture permission denied'); clipboard = value; },
} });
document.execCommand = () => false;
const urls = { created: [], revoked: [] };
const originalCreate = URL.createObjectURL.bind(URL);
const originalRevoke = URL.revokeObjectURL.bind(URL);
URL.createObjectURL = (blob) => { const url = originalCreate(blob); urls.created.push(url); return url; };
URL.revokeObjectURL = (url) => { urls.revoked.push(url); originalRevoke(url); };

function Composer({ directory, sessionID }) {
    const history = useUserMessageHistory(sessionID, directory);
    React.useLayoutEffect(() => { counts.history += 1; });
    return <div id="composer"><textarea aria-label="Composer" defaultValue="Draft stays here" onKeyDown={(event) => {
        if (event.key === 'ArrowUp' && history[0]) event.currentTarget.value = history[0];
    }} /><output>{history.join(' | ')}</output></div>;
}
function BroadBaseline() {
    const state = useStore(store);
    const history = buildUserMessageHistory((state.message.session ?? []).map((message) => ({ info: message, parts: state.part[message.id] ?? [] })));
    React.useLayoutEffect(() => { counts.broad += 1; });
    return <span hidden>{history.join(' | ')}</span>;
}
const tool = (name, state, id = name) => ({ id, type: 'tool', messageID: 'assistant', sessionID: 'session', callID: id, tool: name, state });
const noop = () => {};
function Fixture() {
    const [diffStage, setDiffStage] = React.useState('oversized');
    const patchSource = diffStage === 'error' ? '--- a/fixture-renderer-error\n+++ b/fixture-renderer-error\n@@ -1 +1 @@\n-old\n+new' : huge;
    const [stage, setStage] = React.useState('pending');
    const [directory, setDirectory] = React.useState('/fixture');
    const [sessionID, setSession] = React.useState('session');
    const [copyResult, setCopyResult] = React.useState('');
    const questionState = stage === 'answered' ? { status: 'completed', input: { questions: [{ question: 'Choose a color', options: [] }] }, title: 'Question', output: 'Blue', metadata: {}, time: { start: 1, end: 2 } }
        : stage === 'failed' ? { status: 'error', input: {}, error: 'Cancelled', time: { start: 1, end: 2 } }
        : { status: 'pending', input: { questions: [{ question: 'Choose a color', options: [] }] }, raw: '' };
    const parts = [text('explanation', stage === 'plan' ? 'Context before the question.\n<!--plan-->\n# Fixture plan\n\n## Implementation\n\n1. Keep this plan card.' : 'Context before the question.', 'assistant')];
    if (stage !== 'delayed') parts.push(tool(stage === 'similar' ? 'questionnaire' : 'question', questionState));
    const completed = ['answered', 'failed'].includes(stage);
    React.useEffect(() => {
        useUIStore.setState({ chatRenderMode: 'sorted' });
        window.__chatFixture = {
            setStage, setDiffStage, setDirectory, setSession, counts, store, urls, sourceOperations,
            sources: { huge, write, markdown },
            setMode: (chatRenderMode) => useUIStore.setState({ chatRenderMode }),
            stream: (index) => flushSync(() => store.setState({ part: { ...store.getState().part, assistant: [text('stream', `token ${index}`, 'assistant')] } })),
            editUser: () => store.setState({ part: { ...store.getState().part, user: [text('p', 'Edited prompt')] } }),
            clipboard: () => clipboard,
            denyCopy: (value) => { denyClipboard = value; },
        };
        return () => { delete window.__chatFixture; };
    }, []);
    return <main>
        <h1>Chat improvements</h1>
        <p className="fixture-description">Production chat components with isolated stores and synthetic messages.</p>
        <section id="question"><MessageBody sessionId="session" messageId="assistant" parts={parts} isUser={false}
            isMessageCompleted={completed} messageFinish="tool-calls" syntaxTheme={{}} isMobile={false} copiedCode={null}
            onCopyCode={noop} expandedTools={new Set(['question'])} onToggleTool={noop} onShowPopup={noop}
            streamPhase={completed ? 'completed' : 'streaming'} allowAnimation={false} /></section>
        <section id="patch"><ToolPart part={tool('apply_patch', { status: 'completed', input: {}, metadata: { patch: patchSource },
            output: '', title: 'Large patch', time: { start: 1, end: 2 } })} isExpanded onToggle={noop} syntaxTheme={{}} isMobile={false} /></section>
        <section id="write"><ToolPart part={tool('write', { status: 'completed', input: { filePath: '/fixture/new.txt', content: write },
            metadata: {}, output: '', title: 'Large write', time: { start: 1, end: 2 } })} isExpanded onToggle={noop} syntaxTheme={{}} isMobile={false} /></section>
        <section id="fallback"><RawPatchFallback patch={'malformed\n'.repeat(2010)} /></section>
        <button id="copy" onClick={async () => {
            const result = await copyTextToClipboard(getMessageCopyText([text('copy', markdown)], 'assistant'));
            setCopyResult(result.ok ? 'Copied' : 'Copy failed');
        }}>Copy Markdown</button><output id="copy-result">{copyResult}</output>
        <Composer directory={directory} sessionID={sessionID} /><BroadBaseline />
        <output id="stage" data-stage={stage}>{stage}</output>
    </main>;
}
createRoot(document.getElementById('root')).render(
    <RuntimeAPIProvider apis={createWebAPIs()}><I18nProvider><FixtureSyncContext.Provider value={sync}><Fixture /></FixtureSyncContext.Provider></I18nProvider></RuntimeAPIProvider>,
);
