import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { createStore } from 'zustand/vanilla';
import type { ToolPart as ToolPartType } from '@opencode-ai/sdk/v2';
import { withDom } from '@/test/mountedDom';
import { I18nProvider } from '@/lib/i18n';
import { INITIAL_STATE, type State } from '@/sync/types';
import '@/sync/sync-context';
import ToolPart from './ToolPart';

test('a failed question survives remount as a failure without an answer card', async () => {
    const part: ToolPartType = {
        id: 'prt_question', sessionID: 'ses_question', messageID: 'msg_question', type: 'tool', callID: 'call_question', tool: 'question',
        state: { status: 'error', input: { questions: [{ header: 'Layout', question: 'Choose a layout?', options: [{ label: 'Cards' }] }] },
            error: 'owned_tool_capability_unavailable', time: { start: 1, end: 2 } },
    };
    const store = createStore<State>(() => ({ ...INITIAL_STATE, status: 'complete' }));
    const system = { directory: '/fixture', childStores: { children: new Map([['/fixture', store]]),
        ensureChild: () => store, getChild: () => store, subscribeSessionLists: store.subscribe } };
    const SyncContext = (globalThis as unknown as { __devryan_sync_context__: React.Context<unknown> }).__devryan_sync_context__;
    for (const expanded of [false, true, true]) {
        await withDom(async container => {
            const { createRoot } = await import('react-dom/client');
            const root = createRoot(container as unknown as Element);
            try {
                await act(async () => root.render(<I18nProvider><SyncContext.Provider value={system}>
                    <ToolPart part={part} isExpanded={expanded} onToggle={() => {}} syntaxTheme={{}} isMobile={false} />
                </SyncContext.Provider></I18nProvider>));
                expect(container.textContent).toContain('Question failed');
                expect(container.textContent).not.toContain('Asked 1 question');
                expect(container.textContent).not.toContain('Choose a layout?');
                if (expanded) expect(container.textContent).toContain('owned_tool_capability_unavailable');
            } finally { await act(async () => root.unmount()); }
        });
    }
});
