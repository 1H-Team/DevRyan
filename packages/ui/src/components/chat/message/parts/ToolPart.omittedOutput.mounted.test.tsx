import React, { act } from 'react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { useStore } from 'zustand';
import { createOpencodeClient, type Message, type ToolPart as ToolPartType } from '@opencode-ai/sdk/v2/client';
import { withDom, type HostElement } from '@/test/mountedDom';
import { I18nProvider } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import { ChildStoreManager } from '@/sync/child-store';
import { SessionMessageLoader } from '@/sync/session-message-loader';
import type { OmittedToolOutputState } from '@/sync/tool-output';
import '@/sync/sync-context';

// The fixture DOM cannot host refractor; the stand-in renders the same text.
mock.module('react-syntax-highlighter/dist/esm/prism', () => ({
    default: ({ children }: { children?: React.ReactNode }) => <pre>{children}</pre>,
}));
const { default: ToolPart } = await import('./ToolPart');

const DIRECTORY = '/fixture-omitted';
const SESSION = 'ses_omitted';
const ASSISTANT = 'msg_omitted_assistant';
const OUTPUT = 'export const restored = true;';

const fullPart: ToolPartType = {
    id: 'prt_read', sessionID: SESSION, messageID: ASSISTANT, type: 'tool', callID: 'call_read', tool: 'read',
    state: { status: 'completed', input: { filePath: '/fixture-omitted/src/a.ts' }, output: OUTPUT, title: 'a.ts', metadata: {}, time: { start: 1, end: 2 } },
};
const omittedState: OmittedToolOutputState = {
    status: 'completed', input: { filePath: '/fixture-omitted/src/a.ts' }, output: '', title: 'a.ts', metadata: {},
    time: { start: 1, end: 2 }, outputOmitted: true, outputBytes: OUTPUT.length,
};
const omittedPart: ToolPartType = { ...fullPart, state: omittedState };
const assistantInfo = { id: ASSISTANT, sessionID: SESSION, role: 'assistant', time: { created: 1, completed: 2 } } as Message;

const originalGetScopedSdkClient = opencodeClient.getScopedSdkClient;
afterEach(() => {
    Object.defineProperty(opencodeClient, 'getScopedSdkClient', { configurable: true, value: originalGetScopedSdkClient });
});

const mountRow = async (
    isExpanded: boolean,
    run: (api: { container: HostElement; reads: () => number; release: () => void }) => Promise<void>,
) => {
    let reads = 0;
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => { release = resolve; });
    const sdk = createOpencodeClient({ baseUrl: 'http://facade.test', fetch: async (input: RequestInfo | URL) => {
        expect(new URL(input instanceof Request ? input.url : input).pathname).toBe(`/session/${SESSION}/message/${ASSISTANT}`);
        reads += 1;
        await released;
        return Response.json({ info: assistantInfo, parts: [fullPart] });
    } });
    Object.defineProperty(opencodeClient, 'getScopedSdkClient', { configurable: true, value: () => sdk });

    const stores = new ChildStoreManager();
    const loader = new SessionMessageLoader(stores);
    const store = stores.ensureChild(DIRECTORY, { bootstrap: false });
    store.setState({ message: { [SESSION]: [assistantInfo] }, part: { [ASSISTANT]: [omittedPart] } });
    const system = { directory: DIRECTORY, childStores: stores, messageLoader: loader };
    const SyncContext = (globalThis as unknown as { __devryan_sync_context__: React.Context<unknown> }).__devryan_sync_context__;
    const Row = () => {
        const part = useStore(store, (state) => state.part[ASSISTANT]?.[0]);
        return part?.type === 'tool'
            ? <ToolPart part={part} isExpanded={isExpanded} onToggle={() => {}} syntaxTheme={{}} isMobile={false} />
            : null;
    };

    await withDom(async (container) => {
        const { createRoot } = await import('react-dom/client');
        const root = createRoot(container as unknown as Element);
        await act(async () => root.render(
            <I18nProvider>
                <SyncContext.Provider value={system}>
                    <Row />
                </SyncContext.Provider>
            </I18nProvider>,
        ));
        try {
            await run({ container, reads: () => reads, release });
        } finally {
            await act(async () => root.unmount());
            loader.dispose();
            stores.disposeAll();
        }
    });
};

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

describe('history row with omitted output', () => {
    test('a collapsed row reads nothing and shows no output', async () => {
        await mountRow(false, async ({ container, reads }) => {
            await settle();
            expect(reads()).toBe(0);
            expect(container.textContent).not.toContain('Loading output');
            expect(container.textContent).not.toContain(OUTPUT);
        });
    });

    test('expanding loads the message and renders the real output, never a stand-in', async () => {
        await mountRow(true, async ({ container, reads, release }) => {
            await settle();
            expect(reads()).toBe(1);
            expect(container.textContent).toContain(`Loading output (${OUTPUT.length} B)`);
            expect(container.textContent).not.toContain('Provider returned no expandable details');

            release();
            await settle();
            expect(container.textContent).not.toContain('Loading output');
            expect(container.textContent).toContain(OUTPUT);
            expect(reads()).toBe(1);
        });
    });
});
