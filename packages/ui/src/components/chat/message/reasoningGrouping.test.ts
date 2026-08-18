import { describe, expect, test } from 'bun:test';
import type { Part } from '@opencode-ai/sdk/v2';
import {
    coalesceConsecutiveReasoningRows,
    hasDisplayableReasoningText,
    scanConsecutiveReasoningParts,
} from './reasoningGrouping';

const part = (type: Part['type'], id: string, text?: string): Part => ({
    id,
    type,
    text,
} as Part);

describe('reasoning grouping', () => {
    test('scans only the consecutive reasoning run from the requested start', () => {
        const parts = [
            part('reasoning', 'reasoning-1'),
            part('reasoning', 'reasoning-2'),
            part('tool', 'tool-1'),
            part('reasoning', 'reasoning-3'),
        ];

        expect(scanConsecutiveReasoningParts(parts, 0)).toBe(1);
        expect(scanConsecutiveReasoningParts(parts, 1)).toBe(1);
        expect(scanConsecutiveReasoningParts(parts, 2)).toBe(2);
        expect(scanConsecutiveReasoningParts(parts, 3)).toBe(3);
    });

    test('coalesces runs of two or more reasoning rows without crossing boundaries', () => {
        type Activity = { id: string };
        type Row =
            | { type: 'reasoning'; activity: Activity }
            | { type: 'tool'; id: string }
            | { type: 'justification'; id: string };
        const rows: Row[] = [
            { type: 'reasoning', activity: { id: 'reasoning-1' } },
            { type: 'reasoning', activity: { id: 'reasoning-2' } },
            { type: 'tool', id: 'tool-1' },
            { type: 'reasoning', activity: { id: 'reasoning-3' } },
            { type: 'justification', id: 'justification-1' },
            { type: 'reasoning', activity: { id: 'reasoning-4' } },
            { type: 'reasoning', activity: { id: 'reasoning-5' } },
        ];

        const result = coalesceConsecutiveReasoningRows<Activity, Row>(rows);

        expect(result.map((row) => row.type)).toEqual([
            'reasoning-group',
            'tool',
            'reasoning',
            'justification',
            'reasoning-group',
        ]);
        expect(result[0]).toEqual({
            type: 'reasoning-group',
            activities: [{ id: 'reasoning-1' }, { id: 'reasoning-2' }],
        });
        expect(result[4]).toEqual({
            type: 'reasoning-group',
            activities: [{ id: 'reasoning-4' }, { id: 'reasoning-5' }],
        });
    });

    test('keeps single reasoning rows unchanged and identifies empty parts', () => {
        const row = { type: 'reasoning', activity: { id: 'reasoning-1' } } as const;

        expect(coalesceConsecutiveReasoningRows<{ id: string }, typeof row>([row])).toEqual([row]);
        expect(hasDisplayableReasoningText(part('reasoning', 'empty', '  \n '))).toBe(false);
        expect(hasDisplayableReasoningText(part('reasoning', 'content', 'Useful summary.'))).toBe(true);
    });
});
