import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const chatInputSource = readFileSync(
    fileURLToPath(new URL('./ChatInput.tsx', import.meta.url)),
    'utf8',
);
const stopIconSource = readFileSync(
    fileURLToPath(new URL('../icons/StopIconFilled.tsx', import.meta.url)),
    'utf8',
);

describe('ChatInput composer action buttons', () => {
    test('shares a circular, flat, theme-aware button style between Send and Stop', () => {
        const componentStart = chatInputSource.indexOf('const ComposerActionButtons =');
        const componentEnd = chatInputSource.indexOf('const appendWithLineBreaks', componentStart);
        const componentSource = chatInputSource.slice(componentStart, componentEnd);

        expect(componentStart).toBeGreaterThan(-1);
        expect(componentEnd).toBeGreaterThan(componentStart);
        expect(componentSource).toContain('const actionButtonPaletteClass = cn(');
        expect(componentSource).toContain("'bg-[var(--surface-foreground)] text-[var(--surface-background)] shadow-none'");
        expect(componentSource).toContain("'rounded-full',\n        actionButtonPaletteClass");
        expect(componentSource).toContain('className={cn(actionButtonClass, isStopping');
        expect(componentSource).not.toContain('const stopButtonClass');
        expect(componentSource).toContain('<RiArrowUpLine className={cn(actionIconSizeClass)} />');
        expect(componentSource).toContain("<StopIconFilled className={cn(actionIconSizeClass, 'block')} />");
        expect(componentSource).not.toContain('shadow-[0_1px_2px_rgba(0,0,0,0.06),0_3px_10px_rgba(0,0,0,0.10)]');
    });

    test('renders the Stop glyph as a sharp-cornered square', () => {
        expect(stopIconSource).toContain('<path d="M60 60H196V196H60Z" />');
        expect(stopIconSource).not.toContain('A30 30');
    });
});
