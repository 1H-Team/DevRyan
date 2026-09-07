import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const modelControlsSource = readFileSync(
    fileURLToPath(new URL('./ModelControls.tsx', import.meta.url)),
    'utf8',
);

describe('ModelControls composer alignment', () => {
    test('bottom-aligns the shared thinking-label path without changing shell alignment', () => {
        const selectorStart = modelControlsSource.indexOf('const renderVariantSelector = () => {');
        const selectorEnd = modelControlsSource.indexOf('const renderAgentSelector = () => {', selectorStart);
        const selectorSource = modelControlsSource.slice(selectorStart, selectorEnd);
        const thinkingLabelClass = 'model-controls__variant-label truncate text-[10px] font-medium leading-[14px] -my-[2px] py-[2px]';

        expect(selectorStart).toBeGreaterThan(-1);
        expect(selectorEnd).toBeGreaterThan(selectorStart);
        expect(selectorSource.match(new RegExp(thinkingLabelClass.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(1);
        expect(selectorSource.match(/variantLabelAlignmentClass/g)).toHaveLength(1);
        expect(modelControlsSource).toContain("? 'translate-y-[3px]'\n        : 'translate-y-[2px]';");
        expect(modelControlsSource).toContain("const variantGroupSpacingClass = '-ml-1';");
        expect(modelControlsSource).toContain("className={cn('flex min-w-0 shrink-0', variantGroupSpacingClass)}");
        expect(modelControlsSource).toContain("const agentLabelAlignmentClass = isDesktop ? undefined : '-translate-y-px';");

        const agentSelectorStart = modelControlsSource.indexOf('const renderAgentSelector = () => {');
        const agentSelectorEnd = modelControlsSource.indexOf('return (', agentSelectorStart + 200);
        const desktopAgentSelectorSource = modelControlsSource.slice(agentSelectorStart, agentSelectorEnd);

        expect(desktopAgentSelectorSource.match(/agentLabelAlignmentClass/g)).toHaveLength(2);
    });

    test('retains the existing desktop trigger and send-button geometry', () => {
        expect(modelControlsSource).toContain("const buttonHeight = sizeVariant === 'mobile' ? 'h-9' : 'h-8';");

        const chatInputSource = readFileSync(
            fileURLToPath(new URL('./ChatInput.tsx', import.meta.url)),
            'utf8',
        );
        expect(chatInputSource).toContain("const actionButtonSizeClass = isMobile ? 'h-8 w-8' : ('h-7 w-7');");
        expect(chatInputSource).toContain("className={cn('flex items-center flex-1 justify-end', footerGapClass, 'md:gap-x-3')}");
    });
});
