import { readFileSync } from 'node:fs';
import React, { act } from 'react';
import type { Part } from '@opencode-ai/sdk/v2';
import { describe, expect, test } from 'bun:test';

import { withDom, type HostElement } from '@/test/mountedDom';
import { I18nProvider } from '@/lib/i18n/context';
import type { ToolPopupContent } from '../types';
import GeneratedImageGallery from './GeneratedImageResult';

import {
    buildAssistantImagePopup,
    formatExactAssistantImageSize,
    getAssistantImageGalleryClassName,
    type ReadyAssistantImageTileState,
} from './assistantImageGalleryPresentation';
import type { AssistantImageCandidate } from './generatedImageResults';
import { observeNearViewport } from './useNearViewport';

const imageCandidate: AssistantImageCandidate = {
    id: 'assistant-image-one',
    source: '/workspace/art/one.png',
    filename: 'one.png',
    caption: 'Exact caption',
    sourceKind: 'markdown-image',
    messageId: 'message-1',
};

const readyState: ReadyAssistantImageTileState = {
    status: 'ready',
    url: 'blob:one',
    mimeType: 'image/png',
    size: 12_345,
    filename: 'one.png',
};

describe('assistant image gallery presentation', () => {
    test('uses the required one, two, and responsive many-column layouts', () => {
        expect(getAssistantImageGalleryClassName(1)).toContain('grid-cols-1');
        expect(getAssistantImageGalleryClassName(1)).toContain('max-w-md');
        expect(getAssistantImageGalleryClassName(2)).toContain('grid-cols-2');
        expect(getAssistantImageGalleryClassName(2)).toContain('max-w-2xl');
        expect(getAssistantImageGalleryClassName(3)).toContain('grid-cols-2 sm:grid-cols-3');
    });

    test('builds the same single-image popup for pointer and keyboard button activation', async () => {
        const pointerPopup = buildAssistantImagePopup(imageCandidate, readyState);
        const keyboardPopup = buildAssistantImagePopup(imageCandidate, readyState);

        expect(pointerPopup).toEqual(keyboardPopup);
        expect(pointerPopup.image).toEqual({
            url: 'blob:one',
            mimeType: 'image/png',
            filename: 'one.png',
            size: 12_345,
        });
        expect(pointerPopup.image?.gallery).toBe(undefined);
        expect(buildAssistantImagePopup(imageCandidate, {
            status: 'ready',
            url: 'https://upload.wikimedia.org/one.png',
            filename: 'one.png',
        }).image).toEqual({ url: 'https://upload.wikimedia.org/one.png', filename: 'one.png' });
        expect(formatExactAssistantImageSize(12_345)).toBe('12,345 B');

        const popups: ToolPopupContent[] = [];
        const messages = [{
            messageId: 'message-1',
            parts: [{ type: 'text', text: '![Remote caption](https://upload.wikimedia.org/one.png)' } as Part],
        }];
        await withDom(async (container) => {
            const { createRoot } = await import('react-dom/client');
            const root = createRoot(container as unknown as Element);
            try {
                await act(async () => root.render(
                    <I18nProvider>
                        <GeneratedImageGallery messages={messages} onShowPopup={(content) => popups.push(content)} />
                    </I18nProvider>,
                ));
                await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

                const button = container.find((node) => node.tagName === 'BUTTON');
                const figure = container.find((node) => node.getAttribute('data-assistant-image-state') === 'ready');
                // Remote sources render straight into <img>; a cross-origin blob fetch would fail without CORS.
                expect(figure).not.toBeNull();
                expect(container.find((node) => node.tagName === 'IMG')?.getAttribute('src')).toContain('upload.wikimedia.org/one.png');
                // A single tile is sized by its image, never forced into the many-tile aspect box.
                expect(figure?.getAttribute('class')).not.toContain('aspect-[4/3]');

                await act(async () => { button?.click(); });
                expect(popups).toHaveLength(1);

                const press = (key: string) => {
                    let prevented = false;
                    const event = { type: 'keydown', key, target: button, bubbles: true, preventDefault() { prevented = true; }, stopPropagation() {} };
                    for (const listener of (container as HostElement).listeners.get('keydown') ?? []) listener(event);
                    return prevented;
                };
                await act(async () => { press('Enter'); });
                await act(async () => { press(' '); });
                await act(async () => { press('a'); });
                expect(popups).toHaveLength(3);
                expect(popups[1]).toEqual(popups[0]);
                expect(popups[2]).toEqual(popups[0]);
            } finally {
                await act(async () => root.unmount());
            }
        });
    });

    test('starts near-viewport loading once and disconnects its observer', () => {
        let callback: IntersectionObserverCallback | undefined;
        let observed: Element | undefined;
        let disconnectCount = 0;
        let rootMargin: string | undefined;
        class FakeObserver {
            constructor(nextCallback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
                callback = nextCallback;
                rootMargin = options?.rootMargin;
            }
            observe(element: Element) { observed = element; }
            disconnect() { disconnectCount += 1; }
            unobserve() {}
            takeRecords(): IntersectionObserverEntry[] { return []; }
            readonly root = null;
            readonly rootMargin = '';
            readonly thresholds = [];
        }
        const element = {} as Element;
        let nearCount = 0;
        const cleanup = observeNearViewport(
            element,
            () => { nearCount += 1; },
            FakeObserver as unknown as typeof IntersectionObserver,
        );

        expect(observed).toBe(element);
        expect(rootMargin).toBe('640px 0px');
        callback?.([{ isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry], {} as IntersectionObserver);
        callback?.([{ isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry], {} as IntersectionObserver);
        cleanup();
        expect(nearCount).toBe(1);
        expect(disconnectCount).toBe(2);
    });

    test('has one gallery mount and no legacy progressive-group image rendering', () => {
        const messageBody = readFileSync('src/components/chat/message/MessageBody.tsx', 'utf8');
        const assistantText = readFileSync('src/components/chat/message/parts/AssistantTextPart.tsx', 'utf8');
        const progressiveGroup = readFileSync('src/components/chat/message/parts/ProgressiveGroup.tsx', 'utf8');

        expect((messageBody.match(/<AssistantImageGallery/g) ?? []).length).toBe(1);
        expect(messageBody).toContain("lazyWithChunkRecovery(() => import('./parts/GeneratedImageResult'))");
        expect(assistantText).toContain('stripAssistantImageMarkdown(displayTextContent)');
        expect(progressiveGroup).not.toContain('generatedImages');
    });
});
