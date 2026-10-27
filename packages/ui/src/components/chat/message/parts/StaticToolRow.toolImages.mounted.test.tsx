import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { createStore } from 'zustand/vanilla';
import type { ToolPart } from '@opencode-ai/sdk/v2';
import type { TurnActivityRecord } from '../../lib/turns/types';
import type { ToolPopupContent } from '../types';
import { withDom, type HostElement } from '@/test/mountedDom';
import { I18nProvider } from '@/lib/i18n';
import { INITIAL_STATE, type State } from '@/sync/types';
import '@/sync/sync-context';
import { StaticToolRow } from './StaticToolRow';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const dataUrl = (mime: string, bytes: Uint8Array) => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;

const activity = (attachments: unknown[] | undefined): TurnActivityRecord => ({
    id: 'prt_shot', turnId: 'turn', messageId: 'msg_1', partIndex: 0, kind: 'tool',
    part: {
        id: 'prt_shot', sessionID: 'ses_1', messageID: 'msg_1', type: 'tool', tool: 'playwright_browser_take_screenshot', callID: 'call_1',
        state: {
            status: 'completed', input: {}, output: 'Took a screenshot', title: '', metadata: {}, time: { start: 1, end: 2 },
            ...(attachments ? { attachments } : {}),
        },
    } as unknown as ToolPart,
});

const syncSystem = () => {
    const store = createStore<State>(() => ({ ...INITIAL_STATE, status: 'complete' }));
    return { directory: '/fixture', childStores: { children: new Map([['/fixture', store]]), ensureChild: () => store, getChild: () => store, subscribeSessionLists: store.subscribe } };
};

const mount = async (row: TurnActivityRecord, onShowPopup: (content: ToolPopupContent) => void, run: (container: HostElement) => Promise<void>) => {
    await withDom(async (container) => {
        const SyncContext = (globalThis as unknown as { __devryan_sync_context__: React.Context<unknown> }).__devryan_sync_context__;
        const { createRoot } = await import('react-dom/client');
        const root = createRoot(container as unknown as Element);
        await act(async () => root.render(
            <I18nProvider>
                <SyncContext.Provider value={syncSystem()}>
                    <StaticToolRow toolName="playwright_browser_take_screenshot" activities={[row]} animateTailText={false} onShowPopup={onShowPopup} />
                </SyncContext.Provider>
            </I18nProvider>,
        ));
        try {
            await run(container);
        } finally {
            await act(async () => root.unmount());
        }
    });
};

test('an MCP image result renders an allowlisted thumbnail that opens the image viewer', async () => {
    const popups: ToolPopupContent[] = [];
    const row = activity([
        { id: 'att_png', sessionID: 'ses_1', messageID: 'msg_1', type: 'file', mime: 'image/png', url: dataUrl('image/png', PNG), filename: 'page.png' },
        { id: 'att_svg', sessionID: 'ses_1', messageID: 'msg_1', type: 'file', mime: 'image/svg+xml', url: dataUrl('image/svg+xml', SVG) },
    ]);
    await mount(row, (content) => popups.push(content), async (container) => {
        const group = container.find((node) => node.getAttribute('data-tool-image-count') !== null);
        expect(group?.getAttribute('data-tool-image-count')).toBe('1');
        // No observer in this host: the strip counts as near the viewport and decodes once.
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
        const ready = container.find((node) => node.getAttribute('data-tool-image-state') === 'ready');
        expect(ready).not.toBeNull();
        const image = ready?.find((node) => node.tagName === 'IMG');
        expect(image?.getAttribute('src')?.startsWith('blob:')).toBe(true);
        expect(image?.getAttribute('alt')).toBe('page.png');
        // The SVG attachment never renders, and nothing loads a raw data URI or embeds a document.
        const images: HostElement[] = [];
        container.find((node) => { if (node.tagName === 'IMG') images.push(node); return false; });
        expect(images).toHaveLength(1);
        expect(container.find((node) => node.tagName === 'IFRAME' || node.tagName === 'OBJECT' || node.tagName === 'EMBED')).toBeNull();
        expect(container.find((node) => (node.getAttribute('src') ?? '').startsWith('data:'))).toBeNull();

        await act(async () => { ready?.click(); });
        expect(popups).toHaveLength(1);
        expect(popups[0]?.image).toMatchObject({ url: image?.getAttribute('src'), mimeType: 'image/png', filename: 'page.png', size: PNG.byteLength });
        expect(popups[0]?.image?.gallery).toBeUndefined();
    });
});

test('a tool result without image attachments renders no thumbnail strip', async () => {
    await mount(activity(undefined), () => {}, async (container) => {
        expect(container.find((node) => node.getAttribute('data-tool-image-count') !== null)).toBeNull();
        expect(container.textContent).toContain('Playwright');
    });
});
