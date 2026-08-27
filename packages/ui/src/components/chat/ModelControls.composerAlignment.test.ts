import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const modelControlsSource = readFileSync(
    fileURLToPath(new URL('./ModelControls.tsx', import.meta.url)),
    'utf8',
);

describe('ModelControls composer alignment', () => {
    test('centers both web thinking-label paths while preserving shell alignment', () => {
        const selectorStart = modelControlsSource.indexOf('const renderVariantSelector = () => {');
        const selectorEnd = modelControlsSource.indexOf('const renderAgentSelector = () => {', selectorStart);
        const selectorSource = modelControlsSource.slice(selectorStart, selectorEnd);
        const desktopLabelClass = 'inline-flex items-center gap-1 text-[10px] leading-[14px] -my-[2px] py-[2px] font-medium min-w-0 truncate text-muted-foreground';

        expect(selectorStart).toBeGreaterThan(-1);
        expect(selectorEnd).toBeGreaterThan(selectorStart);
        expect(selectorSource.match(new RegExp(desktopLabelClass.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(2);
        expect(selectorSource.match(/variantLabelAlignmentClass/g)).toHaveLength(2);
        expect(modelControlsSource).toContain("const variantLabelAlignmentClass = isDesktop || isVSCodeRuntime ? 'translate-y-[3px]' : undefined;");
    });

    test('retains the centered desktop trigger and send-button geometry', () => {
        expect(modelControlsSource).toContain("const buttonHeight = sizeVariant === 'mobile' ? 'h-9' : sizeVariant === 'vscode' ? 'h-6' : 'h-8';");

        const chatInputSource = readFileSync(
            fileURLToPath(new URL('./ChatInput.tsx', import.meta.url)),
            'utf8',
        );
        expect(chatInputSource).toContain("const actionButtonSizeClass = isMobile ? 'h-8 w-8' : (isVSCode ? 'h-5 w-5' : 'h-7 w-7');");
        expect(chatInputSource).toContain("className={cn('flex items-center flex-1 justify-end', footerGapClass, 'md:gap-x-3')}");
    });
});
