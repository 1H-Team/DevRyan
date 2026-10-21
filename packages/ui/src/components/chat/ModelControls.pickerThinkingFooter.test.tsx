import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';
import { dict } from '../../lib/i18n/messages/en';

const testDir = dirname(fileURLToPath(import.meta.url));
const source = () => readFileSync(resolve(testDir, 'ModelControls.tsx'), 'utf8');

const sliceBetween = (code: string, start: string, end: string) => {
    const startIndex = code.indexOf(start);
    const endIndex = code.indexOf(end, startIndex);
    expect(startIndex).toBeGreaterThan(-1);
    expect(endIndex).toBeGreaterThan(startIndex);
    return code.slice(startIndex, endIndex);
};

describe('ModelControls picker thinking footer', () => {
    test('replaces the keyboard hint footer with the thinking slider', () => {
        const footer = sliceBetween(source(), '{/* Thinking footer for the selected model */}', '</DropdownMenuContent>');

        expect(footer).toContain('<ThinkingSlider');
        expect(footer).toContain('thinkingControl.apply({ effort })');
        expect(footer).toContain('thinkingControl.apply({ fastEnabled })');
        expect(source()).not.toContain('chat.modelControls.keyboardHint');
        expect(Object.keys(dict).some((key) => key.startsWith('chat.modelControls.keyboardHint'))).toBe(false);
    });

    test('selecting a picker row keeps the picker open', () => {
        const code = source();
        const applyPickerItem = sliceBetween(code, 'const applyPickerItem = ', '};');
        expect(applyPickerItem).toContain('keepOpen: true');
        expect(code).toContain('onClick={() => handleProviderAndModelChange(providerID, modelID, { keepOpen: true })}');
        expect(sliceBetween(code, 'const stepPickerItemThinking = ', '\n        };')).toContain('keepOpen: true');
    });

    test('model changes close the picker only without keepOpen', () => {
        const handler = sliceBetween(source(), 'const handleProviderAndModelChange = (', '\n    };');
        const keepOpenIndex = handler.indexOf('if (options?.keepOpen) {');
        const closeIndex = handler.indexOf('setAgentMenuOpen(false);');

        expect(keepOpenIndex).toBeGreaterThan(-1);
        expect(closeIndex).toBeGreaterThan(keepOpenIndex);
    });
});
