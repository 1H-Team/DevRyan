import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';
import { dict } from '../../lib/i18n/messages/en';

const testDir = dirname(fileURLToPath(import.meta.url));
const source = () => readFileSync(resolve(testDir, 'ModelControls.tsx'), 'utf8');

describe('ModelControls keyboard hints', () => {
    test('uses capitalized control labels', () => {
        expect(dict['chat.modelControls.keyboardHintNavigate']).toBe('↑↓ Navigate');
        expect(dict['chat.modelControls.keyboardHintSwitchAgent']).toBe('Tab Switch Agent');
        expect(dict['chat.modelControls.keyboardHintThinking']).toBe('←→ Thinking');
        expect(dict['chat.modelControls.keyboardHintSelect']).toBe('{modifier}1–9 Select');
    });

    test('renders decorative separators and hides the Thinking separator with its hint', () => {
        const code = source();
        const footerStart = code.indexOf('{/* Keyboard hints footer */}');
        const footerEnd = code.indexOf('</DropdownMenuContent>', footerStart);
        const footer = code.slice(footerStart, footerEnd);

        expect(footerStart).toBeGreaterThan(-1);
        expect(footerEnd).toBeGreaterThan(footerStart);
        expect(footer.match(/<span aria-hidden="true">\|<\/span>/g)).toHaveLength(3);
        expect(footer).toContain(
            "className={cn('inline-flex items-center gap-x-2', !highlightedSupportsThinking && 'invisible')}",
        );

        const separator = '<span aria-hidden="true">|</span>';
        const navigateIndex = footer.indexOf("t('chat.modelControls.keyboardHintNavigate')");
        const firstSeparatorIndex = footer.indexOf(separator);
        const selectIndex = footer.indexOf("t('chat.modelControls.keyboardHintSelect'");
        const secondSeparatorIndex = footer.indexOf(separator, firstSeparatorIndex + 1);
        const switchAgentIndex = footer.indexOf("t('chat.modelControls.keyboardHintSwitchAgent')");
        const conditionalGroupIndex = footer.indexOf("!highlightedSupportsThinking && 'invisible'");
        const thirdSeparatorIndex = footer.indexOf(separator, secondSeparatorIndex + 1);
        const thinkingIndex = footer.indexOf("t('chat.modelControls.keyboardHintThinking')");

        expect(navigateIndex).toBeLessThan(firstSeparatorIndex);
        expect(firstSeparatorIndex).toBeLessThan(selectIndex);
        expect(selectIndex).toBeLessThan(secondSeparatorIndex);
        expect(secondSeparatorIndex).toBeLessThan(switchAgentIndex);
        expect(switchAgentIndex).toBeLessThan(conditionalGroupIndex);
        expect(conditionalGroupIndex).toBeLessThan(thirdSeparatorIndex);
        expect(thirdSeparatorIndex).toBeLessThan(thinkingIndex);
    });
});
