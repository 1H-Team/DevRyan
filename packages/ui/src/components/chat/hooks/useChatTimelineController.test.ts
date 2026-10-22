import React, { act } from 'react';
import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2';

import { withDom } from '../../bots/chat/botMountedDom';
import { shouldCapturePrependScrollSnapshot, useChatTimelineController, VIEWED_TRIM_SETTLE_MS } from './useChatTimelineController';
import { clampTurnStart } from '../lib/turns/windowTurns';
import type { ChatMessageEntry } from '../lib/turns/types';

describe('shouldCapturePrependScrollSnapshot', () => {
    test('captures reader position when loading older history while released', () => {
        expect(shouldCapturePrependScrollSnapshot({
            preserveViewport: true,
            isPinned: false,
            hasContainer: true,
        })).toBe(true);
    });

    test('does not capture while pinned so auto-follow owns bottom restoration', () => {
        expect(shouldCapturePrependScrollSnapshot({
            preserveViewport: true,
            isPinned: true,
            hasContainer: true,
        })).toBe(false);
    });

    test('does not capture without an explicit preserve request', () => {
        expect(shouldCapturePrependScrollSnapshot({
            preserveViewport: false,
            isPinned: false,
            hasContainer: true,
        })).toBe(false);
    });
});

describe('session-switch turn window', () => {
    test('clamps a longer session window before rendering a one-turn session', () => {
        expect(clampTurnStart(12, 1)).toBe(0);
    });
});

describe('settled transcript trim', () => {
    type Options = Parameters<typeof useChatTimelineController>[0];
    const entry = (id: string, role: 'user' | 'assistant'): ChatMessageEntry => ({
        info: { id, role, time: { created: 1 }, ...(role === 'assistant' ? { parentID: 'u1' } : {}) } as Message,
        parts: [] as Part[],
    });
    const base = (overrides: Partial<Options>): Options => ({
        sessionId: 'ses_open',
        messages: [entry('u1', 'user')],
        historyMeta: null,
        scrollRef: { current: null },
        messageListRef: { current: null },
        loadMoreMessages: async () => {},
        goToBottom: () => {},
        releaseAutoFollow: () => {},
        isPinned: true,
        showScrollButton: false,
        ...overrides,
    });

    const run = async (steps: (api: { render: (options: Partial<Options>) => Promise<void>; advance: () => Promise<void> }) => Promise<void>) => {
        const timers = new Map<number, () => void>();
        let nextTimer = 0;
        const originalSetTimeout = globalThis.setTimeout;
        const originalClearTimeout = globalThis.clearTimeout;
        globalThis.setTimeout = ((callback: () => void, ms?: number) => {
            if (ms !== VIEWED_TRIM_SETTLE_MS) return originalSetTimeout(callback, ms);
            nextTimer += 1;
            timers.set(nextTimer, callback);
            return nextTimer;
        }) as unknown as typeof setTimeout;
        globalThis.clearTimeout = ((id: number) => {
            if (!timers.delete(id)) originalClearTimeout(id);
        }) as unknown as typeof clearTimeout;
        try {
            await withDom(async (container) => {
                const { createRoot } = await import('react-dom/client');
                const root = createRoot(container as unknown as Element);
                const Probe = ({ options }: { options: Options }) => {
                    useChatTimelineController(options);
                    return null;
                };
                const render = async (options: Partial<Options>) => {
                    await act(async () => root.render(React.createElement(Probe, { options: base(options) })));
                };
                const advance = async () => {
                    const pending = [...timers.values()];
                    timers.clear();
                    await act(async () => { for (const callback of pending) callback(); });
                };
                try {
                    await steps({ render, advance });
                } finally {
                    await act(async () => root.unmount());
                }
            });
        } finally {
            globalThis.setTimeout = originalSetTimeout;
            globalThis.clearTimeout = originalClearTimeout;
        }
    };

    test('trims once the transcript has settled while the reader follows the end', async () => {
        const trimmed: string[] = [];
        const trimSettledHistory = (sessionId: string) => { trimmed.push(sessionId); };
        await run(async ({ render, advance }) => {
            const first = [entry('u1', 'user')];
            await render({ messages: first, trimSettledHistory });
            // A new message restarts the wait: only the settled state trims.
            await render({ messages: [...first, entry('a1', 'assistant')], trimSettledHistory });
            await advance();
            expect(trimmed).toEqual(['ses_open']);
        });
    });

    test('never trims while the reader is scrolled into history', async () => {
        const trimmed: string[] = [];
        await run(async ({ render, advance }) => {
            await render({ isPinned: false, trimSettledHistory: (sessionId) => { trimmed.push(sessionId); } });
            await advance();
            expect(trimmed).toEqual([]);
        });
    });
});
