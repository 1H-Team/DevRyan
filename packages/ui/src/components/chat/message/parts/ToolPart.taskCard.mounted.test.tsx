import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createStore } from 'zustand/vanilla';
import type { Message, Part, ToolPart as ToolPartType } from '@opencode-ai/sdk/v2';
import { withDom, type HostElement } from '@/test/mountedDom';
import { I18nProvider } from '@/lib/i18n';
import { INITIAL_STATE, type State } from '@/sync/types';
import '@/sync/sync-context';
import ToolPart from './ToolPart';

const DIRECTORY = '/fixture';
const PARENT = 'ses_parent';
const CHILD = 'ses_child';
const CHILD_ASSISTANT = 'msg_child_assistant';

const childTool = (index: number): Part => ({
    id: `prt_child_tool_${index}`, sessionID: CHILD, messageID: CHILD_ASSISTANT, type: 'tool', callID: `call_${index}`, tool: 'read',
    state: { status: 'completed', input: { filePath: `/fixture/src/file-${index}.ts` }, output: 'ok', title: `file-${index}.ts`, metadata: {}, time: { start: 1, end: 2 } },
} as unknown as Part);
const childText = (text: string): Part => ({ id: 'prt_child_text', sessionID: CHILD, messageID: CHILD_ASSISTANT, type: 'text', text } as unknown as Part);
const taskPart = {
    id: 'prt_task', sessionID: PARENT, messageID: 'msg_parent_assistant', type: 'tool', callID: 'call_task', tool: 'task',
    state: {
        status: 'running',
        input: { subagent_type: 'explorer', description: 'Investigate the calendar', prompt: 'Read-only investigation.' },
        metadata: { sessionId: CHILD }, title: 'Investigate the calendar', time: { start: 1 },
    },
} as unknown as ToolPartType;

const createSync = () => {
    const store = createStore<State>(() => ({
        ...INITIAL_STATE,
        status: 'complete',
        // The child is absent from the session list, so opening never fetches it.
        session_status: { [PARENT]: { type: 'busy' }, [CHILD]: { type: 'busy' } },
        message: { [CHILD]: [{ id: CHILD_ASSISTANT, sessionID: CHILD, role: 'assistant', time: { created: 1 } } as unknown as Message] },
        part: { [CHILD_ASSISTANT]: [childTool(0), childTool(1), childText('')] },
    }));
    const system = {
        directory: DIRECTORY,
        childStores: { children: new Map([[DIRECTORY, store]]), ensureChild: () => store, getChild: () => store, subscribeSessionLists: store.subscribe },
    };
    return { store, system };
};

const streamChild = (store: ReturnType<typeof createSync>['store'], updates: number) => {
    for (let index = 0; index < updates; index += 1) {
        store.setState((state) => {
            const parts = state.part[CHILD_ASSISTANT]!;
            const text = (parts[parts.length - 1] as Part & { text: string }).text;
            return { part: { ...state.part, [CHILD_ASSISTANT]: [...parts.slice(0, -1), childText(`${text}chunk ${index} `)] } };
        });
    }
};

const mountTaskCard = async (
    isExpanded: boolean,
    run: (api: { container: HostElement; store: ReturnType<typeof createSync>['store']; commits: () => number }) => Promise<void>,
) => {
    await withDom(async (container) => {
        const { store, system } = createSync();
        const SyncContext = (globalThis as unknown as { __devryan_sync_context__: React.Context<unknown> }).__devryan_sync_context__;
        let commits = 0;
        const { createRoot } = await import('react-dom/client');
        const root = createRoot(container as unknown as Element);
        await act(async () => root.render(
            <I18nProvider>
                <SyncContext.Provider value={system}>
                    <React.Profiler id="task-card" onRender={() => { commits += 1; }}>
                        <ToolPart part={taskPart} isExpanded={isExpanded} onToggle={() => {}} syntaxTheme={{}} isMobile={false} />
                    </React.Profiler>
                </SyncContext.Provider>
            </I18nProvider>,
        ));
        try {
            await run({ container, store, commits: () => commits });
        } finally {
            await act(async () => root.unmount());
        }
    });
};

const originalFetch = globalThis.fetch;
beforeEach(() => {
    // An opened card polls the child session; keep the test off the network.
    globalThis.fetch = (async () => { throw new Error('offline test'); }) as unknown as typeof fetch;
});
afterEach(() => {
    globalThis.fetch = originalFetch;
});

describe('sub-agent task card', () => {
    test('a collapsed card renders from the tool part and never re-renders while the child streams', async () => {
        await mountTaskCard(false, async ({ container, store, commits }) => {
            expect(container.textContent).toContain('Investigate the calendar');
            expect(container.textContent).toContain('Open Explorer Subtask');
            expect(container.textContent).not.toContain('Read 2 files');
            const settled = commits();

            await act(async () => streamChild(store, 60));

            expect(commits()).toBe(settled);
        });
    });

    test('an opened card loads the child session activity and follows it', async () => {
        await mountTaskCard(true, async ({ container, store, commits }) => {
            expect(container.textContent).toContain('Read 2 files');
            const settled = commits();

            await act(async () => {
                store.setState((state) => ({ part: { ...state.part, [CHILD_ASSISTANT]: [childTool(0), childTool(1), childTool(2), childText('')] } }));
                // The row count animates between values.
                await new Promise((resolve) => setTimeout(resolve, 500));
            });

            expect(container.textContent).toContain('Read 3 files');
            expect(commits()).toBeGreaterThan(settled);
        });
    });
});
