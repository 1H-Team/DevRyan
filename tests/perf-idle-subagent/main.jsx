import React from 'react';
import { createRoot } from 'react-dom/client';
import { createStore } from 'zustand/vanilla';
import { I18nProvider } from '@/lib/i18n';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { useSessionMessageRecords } from '@/sync/sync-context';
import { INITIAL_STATE } from '@/sync/types';
import ToolPart from '@/components/chat/message/parts/ToolPart';
import { WorkingPlaceholder } from '@/components/chat/message/parts/WorkingPlaceholder';
import { SessionStatusDot } from '@/components/session/sidebar/SessionStatusDot';
import { ManagedTaskRowView } from '@/components/chat/ManagedTaskRow';
import { createWebAPIs } from '../../packages/web/src/api';
import '../../packages/ui/src/index.css';

// Idle "Waiting for subagent output" view: a busy parent whose transcript ends in
// running sub-agent cards, while the children stream into the same directory store.
const DIRECTORY = '/fixture';
const PARENT = 'ses_parent';
const CHILDREN = ['ses_child_1', 'ses_child_2', 'ses_child_3', 'ses_child_4'];
const COMPLETED_TOOLS = 40;
const STREAM_INTERVAL_MS = 100;
const now = Date.now();

const info = (id, sessionID, role, extra = {}) => ({ id, sessionID, role, time: { created: now - 60_000 }, ...extra });
const tool = (id, messageID, sessionID, name, state) => ({ id, type: 'tool', messageID, sessionID, callID: id, tool: name, state });
const completedTool = (index, messageID, sessionID) => tool(`prt_tool_${sessionID}_${index}`, messageID, sessionID, index % 3 === 0 ? 'read' : index % 3 === 1 ? 'grep' : 'bash', {
    status: 'completed',
    input: index % 3 === 0 ? { filePath: `/fixture/src/file-${index}.ts` } : index % 3 === 1 ? { pattern: `symbol${index}` } : { command: `echo ${index}`, description: `Step ${index}` },
    output: `result ${index}`, title: `Step ${index}`, metadata: {}, time: { start: now - 50_000 + index, end: now - 50_000 + index + 1 },
});
const taskTool = (child, index) => tool(`prt_task_${index}`, 'msg_parent_assistant', PARENT, 'task', {
    status: 'running',
    input: { subagent_type: 'explorer', description: `Investigate area ${index + 1}`, prompt: `Read-only investigation ${index + 1}.` },
    metadata: { sessionId: child }, title: `Investigate area ${index + 1}`, time: { start: now - 30_000 },
});

const parentParts = [
    { id: 'prt_parent_text', type: 'text', messageID: 'msg_parent_assistant', sessionID: PARENT, text: 'Dispatching the investigation to sub-agents.' },
    ...Array.from({ length: COMPLETED_TOOLS }, (_, index) => completedTool(index, 'msg_parent_assistant', PARENT)),
    ...CHILDREN.slice(0, 3).map(taskTool),
];
const initialState = {
    ...INITIAL_STATE,
    status: 'complete',
    session: [
        { id: PARENT, directory: DIRECTORY, title: 'Parent', time: { created: now - 60_000, updated: now } },
        ...CHILDREN.map((id, index) => ({ id, parentID: PARENT, directory: DIRECTORY, title: `Explorer ${index + 1}`, time: { created: now - 30_000, updated: now } })),
    ],
    session_status: Object.fromEntries([PARENT, ...CHILDREN].map((id) => [id, { type: 'busy' }])),
    message: {
        [PARENT]: [info('msg_parent_user', PARENT, 'user'), info('msg_parent_assistant', PARENT, 'assistant', { parentID: 'msg_parent_user' })],
        ...Object.fromEntries(CHILDREN.map((id) => [id, [info(`msg_${id}_user`, id, 'user'), info(`msg_${id}_assistant`, id, 'assistant', { parentID: `msg_${id}_user` })]])),
    },
    part: {
        msg_parent_user: [{ id: 'prt_parent_user', type: 'text', messageID: 'msg_parent_user', sessionID: PARENT, text: 'Investigate the calendar.' }],
        msg_parent_assistant: parentParts,
        ...Object.fromEntries(CHILDREN.flatMap((id) => [
            [`msg_${id}_user`, [{ id: `prt_${id}_user`, type: 'text', messageID: `msg_${id}_user`, sessionID: id, text: 'Investigate.' }]],
            [`msg_${id}_assistant`, [
                ...Array.from({ length: 8 }, (_, index) => completedTool(index, `msg_${id}_assistant`, id)),
                { id: `prt_${id}_text`, type: 'text', messageID: `msg_${id}_assistant`, sessionID: id, text: '' },
            ]],
        ])),
    },
};
const store = createStore(() => initialState);
const childStores = {
    children: new Map([[DIRECTORY, store]]),
    ensureChild: () => store,
    getChild: () => store,
    subscribeSessionLists: (notify) => store.subscribe(notify),
};
// The production module shares this context across chunks; supply only isolated fixture state.
const FixtureSyncContext = globalThis.__devryan_sync_context__;
const sync = { childStores, directory: DIRECTORY };

const stats = { storeUpdates: 0 };
let streamTimer = null;
let streamIndex = 0;
const streamTick = () => {
    const child = CHILDREN[streamIndex % CHILDREN.length];
    streamIndex += 1;
    const messageID = `msg_${child}_assistant`;
    store.setState((state) => {
        const parts = state.part[messageID];
        const last = parts[parts.length - 1];
        return { part: { ...state.part, [messageID]: [...parts.slice(0, -1), { ...last, text: `${last.text}Streaming child output ${streamIndex}. ` }] } };
    });
    stats.storeUpdates += 1;
};

const runningTask = (childSessionId, index) => ({ taskId: `dvr_task_${index}`, rootSessionId: PARENT, parentTaskId: null, childSessionId,
    status: 'running', agent: 'explorer', providerId: 'openai', modelId: 'fixture-model', variant: null,
    label: `Managed investigation ${index + 1}`, startedAt: now - 30_000, failureKind: null, failureReason: null,
    agentRetryAvailable: false, manualRecoveryRequired: false });
const noop = () => {};

function Transcript() {
    // Mirrors ChatContainer's subscription to the open session.
    const records = useSessionMessageRecords(PARENT, DIRECTORY);
    const parts = records.find((record) => record.info.id === 'msg_parent_assistant')?.parts ?? [];
    return <section id="transcript">
        {parts.map((part) => part.type === 'tool'
            ? <ToolPart key={part.id} part={part} isExpanded={false} onToggle={noop} syntaxTheme={{}} isMobile={false} />
            : <p key={part.id}>{part.text}</p>)}
        <div id="managed">
            {CHILDREN.map((child, index) => <ManagedTaskRowView key={child} task={runningTask(child, index)} onOpenChild={noop} childActive />)}
        </div>
    </section>;
}

function Fixture() {
    return <main style={{ display: 'flex', gap: 24, padding: 16, height: '100vh', boxSizing: 'border-box' }}>
        <nav id="sidebar" style={{ width: 220, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {[PARENT, ...CHILDREN].map((id) => <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <SessionStatusDot presentation={{ kind: 'working', labelKey: 'working' }} label="Working" />
                <span className="typography-ui-label">{id}</span>
            </div>)}
        </nav>
        <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
            <Transcript />
            <div id="status-row" style={{ height: 28, marginTop: 12 }}>
                <WorkingPlaceholder isWorking statusText="waiting for subagent output" />
            </div>
        </div>
    </main>;
}

window.__idleFixture = {
    ready: true,
    stats,
    startStream: () => { streamTimer ??= window.setInterval(streamTick, STREAM_INTERVAL_MS); },
    stopStream: () => { if (streamTimer !== null) window.clearInterval(streamTimer); streamTimer = null; },
};
createRoot(document.getElementById('root')).render(
    <RuntimeAPIProvider apis={createWebAPIs()}><I18nProvider><FixtureSyncContext.Provider value={sync}><Fixture /></FixtureSyncContext.Provider></I18nProvider></RuntimeAPIProvider>,
);
