import { describe, expect, test } from 'bun:test';

import { shouldCapturePrependScrollSnapshot } from './useChatTimelineController';
import { clampTurnStart } from '../lib/turns/windowTurns';

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
