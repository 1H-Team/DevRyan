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

// Desktop dropdown content cannot be mounted in the host DOM; the trigger
// placement and mobile picker are asserted in ModelControls.behavior.test.tsx.
describe('ModelControls picker thinking footer', () => {
    test('replaces the keyboard hint footer with the thinking slider', () => {
        const footer = sliceBetween(source(), '{/* Thinking footer for the selected model, pinned under the model list */}', '</DropdownMenuContent>');

        expect(footer).toContain('<ThinkingSlider');
        expect(footer).toContain('thinkingControl.apply({ effort })');
        expect(footer).toContain('thinkingControl.apply({ fastEnabled })');
        expect(source()).not.toContain('chat.modelControls.keyboardHint');
        expect(Object.keys(dict).some((key) => key.startsWith('chat.modelControls.keyboardHint'))).toBe(false);
    });

    test('pins the thinking footer inside the models column, right of the provider rail', () => {
        const code = source();
        const column = sliceBetween(code, '<div className="flex min-h-0 min-w-0 flex-1 flex-col">', '</DropdownMenuContent>');
        const listEnd = column.indexOf('</ScrollableOverlay>');
        const footerStart = column.indexOf('{/* Thinking footer for the selected model, pinned under the model list */}');

        expect(listEnd).toBeGreaterThan(-1);
        expect(footerStart).toBeGreaterThan(listEnd);
        // The footer is the column's last child: after it only the column and the rail row close.
        expect(column.slice(footerStart)).toContain('model-controls__picker-thinking shrink-0');
        expect(/\) : null\}\s*<\/div>\s*<\/div>\s*$/.test(column.slice(footerStart))).toBe(true);
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
