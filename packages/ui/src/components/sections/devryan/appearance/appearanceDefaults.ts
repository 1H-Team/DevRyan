import { DEFAULT_CHAT_WIDTH } from '@/lib/chatLayout';
import { DEFAULT_MONO_FONT, DEFAULT_UI_FONT } from '@/lib/fontOptions';

/** Values the Appearance reset buttons restore; must match the UI store's initial state. */
export const APPEARANCE_DEFAULTS = {
    uiFont: DEFAULT_UI_FONT,
    monoFont: DEFAULT_MONO_FONT,
    fontSize: 100,
    terminalFontSize: 13,
    chatWidth: DEFAULT_CHAT_WIDTH,
    padding: 100,
    inputBarOffset: 0,
} as const;

export const FONT_SIZE_RANGE = { min: 50, max: 200, step: 5 } as const;
export const TERMINAL_FONT_SIZE_RANGE = { min: 9, max: 52, step: 1 } as const;
export const SPACING_RANGE = { min: 50, max: 200, step: 5 } as const;
export const INPUT_BAR_OFFSET_RANGE = { min: 0, max: 100, step: 5 } as const;
