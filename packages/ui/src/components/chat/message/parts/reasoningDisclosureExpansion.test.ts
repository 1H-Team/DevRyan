import { describe, expect, test } from 'bun:test';
import {
    getReasoningDisclosureKey,
    readReasoningDisclosureExpansion,
    writeReasoningDisclosureExpansion,
} from './reasoningDisclosureExpansion';

describe('reasoning disclosure expansion retention', () => {
    test('restores only the exact session, message, and first part choice', () => {
        const key = getReasoningDisclosureKey('session', 'message', 'part');
        writeReasoningDisclosureExpansion(key, true);
        expect(readReasoningDisclosureExpansion(key)).toBe(true);
        expect(readReasoningDisclosureExpansion(getReasoningDisclosureKey('other', 'message', 'part'))).toBe(false);
        expect(readReasoningDisclosureExpansion(getReasoningDisclosureKey('session', 'other', 'part'))).toBe(false);
        expect(readReasoningDisclosureExpansion(getReasoningDisclosureKey('session', 'message', 'other'))).toBe(false);
        writeReasoningDisclosureExpansion(key, false);
        expect(readReasoningDisclosureExpansion(key)).toBe(false);
    });

    test('does not retain choices without a complete identity', () => {
        expect(getReasoningDisclosureKey(undefined, 'message', 'part')).toBeNull();
        expect(getReasoningDisclosureKey('session', '', 'part')).toBeNull();
        expect(getReasoningDisclosureKey('session', 'message', undefined)).toBeNull();
        writeReasoningDisclosureExpansion(null, true);
        expect(readReasoningDisclosureExpansion(null)).toBe(false);
        expect(getReasoningDisclosureKey('a:b', 'c', 'd')).not.toBe(getReasoningDisclosureKey('a', 'b:c', 'd'));
    });

    test('evicts least recently read choices at the count limit', () => {
        const keys = Array.from({ length: 4_001 }, (_, index) => `count-${index}`);
        keys.slice(0, -1).forEach((key) => writeReasoningDisclosureExpansion(key, true));
        expect(readReasoningDisclosureExpansion(keys[0])).toBe(true);
        writeReasoningDisclosureExpansion(keys[4_000], true);
        expect(readReasoningDisclosureExpansion(keys[0])).toBe(true);
        expect(readReasoningDisclosureExpansion(keys[1])).toBe(false);
        keys.forEach((key) => writeReasoningDisclosureExpansion(key, false));
    });

    test('bounds retained key bytes independently of the entry count', () => {
        const first = `first-${'x'.repeat(140_000)}`;
        const second = `second-${'x'.repeat(140_000)}`;
        writeReasoningDisclosureExpansion(first, true);
        writeReasoningDisclosureExpansion(second, true);
        expect(readReasoningDisclosureExpansion(first)).toBe(false);
        expect(readReasoningDisclosureExpansion(second)).toBe(true);
        const oversized = 'x'.repeat(512 * 1024);
        writeReasoningDisclosureExpansion(oversized, true);
        expect(readReasoningDisclosureExpansion(oversized)).toBe(false);
        writeReasoningDisclosureExpansion(second, false);
    });
});
