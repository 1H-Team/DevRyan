import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

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
    objectUrl: 'blob:one',
    mimeType: 'image/png',
    size: 12_345,
    filename: 'one.png',
};

describe('assistant image gallery presentation', () => {
    test('uses the required one, two, and responsive many-column layouts', () => {
        expect(getAssistantImageGalleryClassName(1)).toContain('grid-cols-1');
        expect(getAssistantImageGalleryClassName(1)).toContain('max-w-2xl');
        expect(getAssistantImageGalleryClassName(2)).toContain('grid-cols-2');
        expect(getAssistantImageGalleryClassName(2)).toContain('max-w-4xl');
        expect(getAssistantImageGalleryClassName(3)).toContain('grid-cols-2 sm:grid-cols-3');
    });

    test('builds the same single-image popup for pointer and keyboard button activation', () => {
        const gallerySource = readFileSync('src/components/chat/message/parts/GeneratedImageResult.tsx', 'utf8');
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
        expect(formatExactAssistantImageSize(12_345)).toBe('12,345 B');
        expect(gallerySource).toContain("event.key !== 'Enter' && event.key !== ' '");
        expect(gallerySource).toContain('openPreview(candidate, state);');
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

    test('has one gallery mount and no legacy inline or tool-row image rendering', () => {
        const messageBody = readFileSync('src/components/chat/message/MessageBody.tsx', 'utf8');
        const assistantText = readFileSync('src/components/chat/message/parts/AssistantTextPart.tsx', 'utf8');
        const staticToolRow = readFileSync('src/components/chat/message/parts/StaticToolRow.tsx', 'utf8');
        const progressiveGroup = readFileSync('src/components/chat/message/parts/ProgressiveGroup.tsx', 'utf8');

        expect((messageBody.match(/<AssistantImageGallery/g) ?? []).length).toBe(1);
        expect(messageBody).toContain("lazyWithChunkRecovery(() => import('./parts/GeneratedImageResult'))");
        expect(assistantText).toContain('stripAssistantImageMarkdown(displayTextContent)');
        expect(assistantText).not.toContain('<GeneratedImageResult');
        expect(staticToolRow).not.toContain('GeneratedImageResult');
        expect(progressiveGroup).not.toContain('generatedImages');
    });
});
