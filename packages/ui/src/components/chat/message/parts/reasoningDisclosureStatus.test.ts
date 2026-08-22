import { describe, expect, test } from 'bun:test';

import {
    hasActiveReasoningDisclosure,
    registerActiveReasoningDisclosure,
} from './reasoningDisclosureStatus';

describe('active reasoning disclosure ownership', () => {
    test('keeps ownership until every disclosure for a session unregisters', () => {
        const sessionID = 'session-multiple';
        const unregisterFirst = registerActiveReasoningDisclosure(sessionID);
        const unregisterSecond = registerActiveReasoningDisclosure(sessionID);

        expect(hasActiveReasoningDisclosure(sessionID)).toBe(true);
        unregisterFirst();
        expect(hasActiveReasoningDisclosure(sessionID)).toBe(true);
        unregisterSecond();
        expect(hasActiveReasoningDisclosure(sessionID)).toBe(false);
    });

    test('isolates sessions and makes cleanup idempotent', () => {
        const unregister = registerActiveReasoningDisclosure('session-a');

        expect(hasActiveReasoningDisclosure('session-a')).toBe(true);
        expect(hasActiveReasoningDisclosure('session-b')).toBe(false);
        unregister();
        unregister();
        expect(hasActiveReasoningDisclosure('session-a')).toBe(false);
    });

    test('treats missing session identity as inactive', () => {
        expect(hasActiveReasoningDisclosure(null)).toBe(false);
        expect(hasActiveReasoningDisclosure(undefined)).toBe(false);
        expect(hasActiveReasoningDisclosure('')).toBe(false);
    });
});
