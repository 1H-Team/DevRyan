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
    });

    test('renders decorative separators and hides the Thinking separator with its hint', () => {
        const code = source();
        const footerStart = code.indexOf('{/* Keyboard hints footer */}');
        const footerEnd = code.indexOf('</DropdownMenuContent>', footerStart);
        const footer = code.slice(footerStart, footerEnd);

        expect(footerStart).toBeGreaterThan(-1);
        expect(footerEnd).toBeGreaterThan(footerStart);
        expect(footer.match(/<span aria-hidden="true">\|<\/span>/g)).toHaveLength(2);
        expect(footer).toContain(
            "className={cn('inline-flex items-center gap-x-2', !highlightedSupportsThinking && 'invisible')}",
        );

        const navigateIndex = footer.indexOf("t('chat.modelControls.keyboardHintNavigate')");
        const firstSeparatorIndex = footer.indexOf('<span aria-hidden="true">|</span>');
        const switchAgentIndex = footer.indexOf("t('chat.modelControls.keyboardHintSwitchAgent')");
        const conditionalGroupIndex = footer.indexOf("!highlightedSupportsThinking && 'invisible'");
        const secondSeparatorIndex = footer.indexOf('<span aria-hidden="true">|</span>', firstSeparatorIndex + 1);
        const thinkingIndex = footer.indexOf("t('chat.modelControls.keyboardHintThinking')");

        expect(navigateIndex).toBeLessThan(firstSeparatorIndex);
        expect(firstSeparatorIndex).toBeLessThan(switchAgentIndex);
        expect(switchAgentIndex).toBeLessThan(conditionalGroupIndex);
        expect(conditionalGroupIndex).toBeLessThan(secondSeparatorIndex);
        expect(secondSeparatorIndex).toBeLessThan(thinkingIndex);
    });
});
