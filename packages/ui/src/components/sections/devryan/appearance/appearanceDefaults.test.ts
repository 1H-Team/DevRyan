import { describe, expect, test } from 'bun:test';

import { useUIStore } from '@/stores/useUIStore';
import { APPEARANCE_DEFAULTS } from './appearanceDefaults';

describe('Appearance reset targets', () => {
    test('match the UI store defaults', () => {
        const initial = useUIStore.getInitialState();

        expect(APPEARANCE_DEFAULTS.uiFont).toBe(initial.uiFont);
        expect(APPEARANCE_DEFAULTS.monoFont).toBe(initial.monoFont);
        expect(APPEARANCE_DEFAULTS.fontSize).toBe(initial.fontSize);
        expect(APPEARANCE_DEFAULTS.terminalFontSize).toBe(initial.terminalFontSize);
        expect(APPEARANCE_DEFAULTS.chatWidth).toBe(initial.chatWidth);
        expect(APPEARANCE_DEFAULTS.padding).toBe(initial.padding);
        expect(APPEARANCE_DEFAULTS.inputBarOffset).toBe(initial.inputBarOffset);
    });
});
