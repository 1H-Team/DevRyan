import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ModelControls' own geometry is asserted on rendered output in
// ModelControls.behavior.test.tsx. ChatInput is too heavy to mount, so its
// half of the contract stays a source pin.
const chatInputSource = readFileSync(
    fileURLToPath(new URL('./ChatInput.tsx', import.meta.url)),
    'utf8',
);

describe('ChatInput composer geometry', () => {
    test('retains the existing send-button geometry', () => {
        expect(chatInputSource).toContain("const actionButtonSizeClass = isMobile ? 'h-8 w-8' : ('h-7 w-7');");
        expect(chatInputSource).toContain("className={cn('flex items-center flex-1 justify-end', footerGapClass, 'md:gap-x-3')}");
    });
});
