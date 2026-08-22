import { describe, expect, test } from 'bun:test';

import { mergeConsecutiveTextParts } from './partUtils';
import type { Part } from '@opencode-ai/sdk/v2/client';

const textPart = (id: string, text: string): Part => ({
    id,
    messageID: 'msg_1',
    sessionID: 'ses_1',
    type: 'text',
    text,
}) as unknown as Part;

const mergedText = (parts: Part[]): string => (mergeConsecutiveTextParts(parts) as { text?: string }).text ?? '';

describe('mergeConsecutiveTextParts', () => {
    test('keeps the transport whitespace at the seam instead of forcing a line break', () => {
        expect(mergedText([
            textPart('a', 'Here is a practical difficulty read.\n\n1.'),
            textPart('b', ' Implementing video bookings is straightforward.'),
        ])).toBe('Here is a practical difficulty read.\n\n1. Implementing video bookings is straightforward.');
    });

    test('does not fabricate an empty ordered-list item when a list splits after its marker', () => {
        const merged = mergedText([
            textPart('a', 'Two options:\n\n1.'),
            textPart('b', ' LiveKit Cloud with TURN from Cloudflare.'),
        ]);
        expect(merged).not.toContain('1.\n');
        expect(merged).toContain('1. LiveKit Cloud');
    });

    test('separates seams with no whitespace using a soft break', () => {
        expect(mergedText([
            textPart('a', 'First block of prose.'),
            textPart('b', 'Second block of prose.'),
        ])).toBe('First block of prose.\nSecond block of prose.');
    });

    test('drops whitespace-only parts', () => {
        expect(mergedText([
            textPart('a', 'Only real content survives.'),
            textPart('b', '   \n'),
            textPart('c', 'And this.'),
        ])).toBe('Only real content survives.\nAnd this.');
    });
});
