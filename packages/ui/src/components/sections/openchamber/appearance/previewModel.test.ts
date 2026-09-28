import { describe, expect, test } from 'bun:test';

import { getChatWidthRatio, parsePreviewMarkdown } from './previewModel';

const percent = (ratio: number): number => Math.round(ratio * 100);

describe('Appearance preview model', () => {
    test('maps the chat width range onto the miniature window', () => {
        expect(percent(getChatWidthRatio(640))).toBe(40);
        expect(percent(getChatWidthRatio(1408))).toBe(88);
        expect(percent(getChatWidthRatio(1024))).toBe(64);
    });

    test('clamps out-of-range and invalid widths', () => {
        expect(percent(getChatWidthRatio(100))).toBe(40);
        expect(percent(getChatWidthRatio(5000))).toBe(88);
        expect(percent(getChatWidthRatio(Number.NaN))).toBe(40);
    });

    test('splits sample text into plain, strong, and code runs', () => {
        expect(parsePreviewMarkdown('Make the **header** sticky and rename `useAuth`.')).toEqual([
            { kind: 'text', text: 'Make the ' },
            { kind: 'strong', text: 'header' },
            { kind: 'text', text: ' sticky and rename ' },
            { kind: 'code', text: 'useAuth' },
            { kind: 'text', text: '.' },
        ]);
    });

    test('leaves text without markup as one plain run', () => {
        expect(parsePreviewMarkdown('No markup here')).toEqual([{ kind: 'text', text: 'No markup here' }]);
        expect(parsePreviewMarkdown('')).toEqual([]);
    });
});
