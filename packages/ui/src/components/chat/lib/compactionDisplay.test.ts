import { describe, expect, test } from 'bun:test';

import { getCompactionBoundary, isCompactionSummaryInfo, readCompactionPart } from './compactionDisplay';

describe('compaction display helpers', () => {
    test('reads automatic and manual compaction request parts', () => {
        expect(readCompactionPart([{ type: 'text' }, { type: 'compaction', auto: true }])).toEqual({ kind: 'automatic' });
        expect(readCompactionPart([{ type: 'compaction', auto: false }])).toEqual({ kind: 'manual' });
        expect(readCompactionPart([{ type: 'compaction' }])).toEqual({ kind: 'manual' });
        expect(readCompactionPart([{ type: 'text' }])).toBeNull();
        expect(readCompactionPart(undefined)).toBeNull();
    });

    test('reads a normalized boundary only when its kind is valid', () => {
        expect(getCompactionBoundary({ info: { clientCompaction: { kind: 'automatic' } } })).toEqual({ kind: 'automatic' });
        expect(getCompactionBoundary({ info: { clientCompaction: { kind: 'other' } } })).toBeNull();
        expect(getCompactionBoundary({ info: {} })).toBeNull();
        expect(getCompactionBoundary(null)).toBeNull();
    });

    test('recognizes native summary assistants', () => {
        expect(isCompactionSummaryInfo({ summary: true })).toBe(true);
        expect(isCompactionSummaryInfo({ mode: 'compaction' })).toBe(true);
        expect(isCompactionSummaryInfo({ agent: 'compaction' })).toBe(true);
        expect(isCompactionSummaryInfo({ agent: 'orchestrator', mode: 'primary' })).toBe(false);
        expect(isCompactionSummaryInfo(null)).toBe(false);
    });
});
