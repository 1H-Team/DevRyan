import { describe, expect, test } from 'bun:test';
import type { SessionContextUsage } from '@/stores/types/sessionTypes';
import {
    resolveContextUsageAvailability,
    shouldShowComposerContextUsage,
} from './contextUsagePresentation';

const usage: SessionContextUsage = {
    activeInputTokens: 1250,
    lastOutputTokens: 0,
    source: 'message-fallback',
    updatedAt: 1,
    percentage: 12.5,
    capacityLimit: 10_000,
    capacityBasis: 'input',
    inputLimit: 10_000,
    contextLimit: 10_000,
    outputLimit: null,
    tokenBreakdown: {
        input: 1250,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 1250,
    },
    hasTokenBreakdown: true,
};

describe('resolveContextUsageAvailability', () => {
    test('keeps drafts idle even if stale usage is supplied', () => {
        expect(resolveContextUsageAvailability({
            sessionId: null,
            usage,
            resolved: true,
        })).toBe('idle');
    });

    test('shows loading while the current session is unresolved', () => {
        expect(resolveContextUsageAvailability({
            sessionId: 'session-a',
            usage: null,
            resolved: false,
        })).toBe('loading');
    });

    test('shows an unavailable state for a resolved unmeasured session', () => {
        expect(resolveContextUsageAvailability({
            sessionId: 'session-a',
            usage: null,
            resolved: true,
        })).toBe('unavailable');
    });

    test('shows available usage as soon as an authoritative measurement arrives', () => {
        expect(resolveContextUsageAvailability({
            sessionId: 'session-a',
            usage,
            resolved: false,
        })).toBe('available');
    });
});

describe('shouldShowComposerContextUsage', () => {
    test('keeps the control present only in the desktop composer', () => {
        expect(shouldShowComposerContextUsage({ isMobile: false, })).toBe(true);
        expect(shouldShowComposerContextUsage({ isMobile: true, })).toBe(false);

    });
});
