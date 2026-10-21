import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import React from 'react';

import { useChatSelectionCopySanitizer } from './useChatSelectionCopySanitizer';

const testDir = dirname(fileURLToPath(import.meta.url));
const read = (relativePath: string) => readFileSync(resolve(testDir, relativePath), 'utf8');

type CopyListener = (event: unknown) => void;
type Globals = { document?: unknown; window?: unknown; Node?: unknown };

const globals = globalThis as unknown as Globals;
const original = {
    document: globals.document,
    window: globals.window,
    Node: globals.Node,
};

interface Harness {
    registered: Array<{ type: string; listener: CopyListener; capture: unknown }>;
    removed: Array<{ type: string; listener: CopyListener; capture: unknown }>;
    cleanup: (() => void) | void;
}

// Mounts the hook by running its effect against a stub document, mirroring what the
// browser does once React commits.
function useMountedSanitizer(selectionText: string, insideUserMessage: boolean, collapsed = false): Harness {
    const harness: Harness = { registered: [], removed: [], cleanup: undefined };
    const messageRoot = { closest: (selector: string) => (selector === '[data-chat-user-message]' ? {} : null) };
    const outsideRoot = { closest: () => null };
    const container = { nodeType: 1, parentElement: null, ...(insideUserMessage ? messageRoot : outsideRoot) };

    globals.Node = { ELEMENT_NODE: 1 };
    globals.document = {
        addEventListener: (type: string, listener: CopyListener, capture: unknown) => {
            harness.registered.push({ type, listener, capture });
        },
        removeEventListener: (type: string, listener: CopyListener, capture: unknown) => {
            harness.removed.push({ type, listener, capture });
        },
    };
    globals.window = {
        getSelection: () => ({
            isCollapsed: collapsed,
            rangeCount: 1,
            getRangeAt: () => ({ commonAncestorContainer: container }),
            toString: () => selectionText,
        }),
    };

    spyOn(React, 'useEffect').mockImplementation(((effect: () => (() => void) | void) => {
        harness.cleanup = effect();
    }) as unknown as typeof React.useEffect);
    useChatSelectionCopySanitizer();
    return harness;
}

const fireCopy = (harness: Harness) => {
    const written: Record<string, string> = {};
    const event = {
        clipboardData: { setData: (type: string, value: string) => { written[type] = value; } },
        defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
    };
    for (const entry of harness.registered) {
        if (entry.type === 'copy') entry.listener(event);
    }
    return { event, written };
};

describe('chat selection copy sanitizer behaviour', () => {
    afterEach(() => {
        (React.useEffect as unknown as { mockRestore?: () => void }).mockRestore?.();
        globals.document = original.document;
        globals.window = original.window;
        globals.Node = original.Node;
    });

    test('listens for copy on document in the capture phase and removes the same listener on cleanup', () => {
        // Chromium dispatches the copy event for a non-editable selection above the
        // React root container, so a synthetic onCopy on the message node never fires.
        const harness = useMountedSanitizer('hello', true);

        expect(harness.registered).toHaveLength(1);
        expect(harness.registered[0]?.type).toBe('copy');
        expect(harness.registered[0]?.capture).toBe(true);

        if (typeof harness.cleanup === 'function') harness.cleanup();
        expect(harness.removed).toHaveLength(1);
        expect(harness.removed[0]?.listener).toBe(harness.registered[0]?.listener);
        expect(harness.removed[0]?.capture).toBe(true);
    });

    test('rewrites the clipboard with sanitized text for user chat message selections', () => {
        const harness = useMountedSanitizer('hello world\n\n', true);
        const { event, written } = fireCopy(harness);

        expect(event.defaultPrevented).toBe(true);
        expect(written['text/plain']).toBe('hello world');
    });

    test('leaves native copy alone outside user messages and for collapsed selections', () => {
        const outside = fireCopy(useMountedSanitizer('code block\n\n', false));
        expect(outside.event.defaultPrevented).toBe(false);
        expect(outside.written).toEqual({});
        (React.useEffect as unknown as { mockRestore?: () => void }).mockRestore?.();

        const collapsed = fireCopy(useMountedSanitizer('hello\n\n', true, true));
        expect(collapsed.event.defaultPrevented).toBe(false);
        expect(collapsed.written).toEqual({});
    });
});

// Wiring contracts: both owners are large components that cannot be mounted here.
describe('chat selection copy sanitizer wiring', () => {
    test('user message root is marked so the document listener can scope to it', () => {
        const messageBodySource = read('../message/MessageBody.tsx');
        expect(messageBodySource).toContain('data-chat-user-message="true"');
        // The unreliable per-message synthetic handler must not be reintroduced.
        expect(messageBodySource).not.toContain('onCopyCapture');
    });

    test('ChatContainer mounts the sanitizer once', () => {
        expect(read('../ChatContainer.tsx')).toContain('useChatSelectionCopySanitizer()');
    });
});
