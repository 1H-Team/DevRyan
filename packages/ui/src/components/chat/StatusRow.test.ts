import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const statusRowSource = readFileSync(
    fileURLToPath(new URL('./StatusRow.tsx', import.meta.url)),
    'utf8',
);

describe('StatusRow tab task-label width', () => {
    test('widens the tucked-tab summary without colliding with Plan or changing the non-tab path', () => {
        expect(statusRowSource).not.toContain('max-w-[60cqw]');
        expect(statusRowSource).toContain('max-w-[min(69cqw,calc(100cqw-6.5rem))]');
        expect(statusRowSource).toContain('max-w-[calc(100cqw-2.25rem)]');
        expect(statusRowSource).toContain('status-row__active-todo max-w-[200px]');
        expect(statusRowSource).toContain('!isTab && isCompact && "max-w-[38cqw]"');
    });
});

describe('StatusRow suppressTab', () => {
    test('hides the tucked tab without unmounting plan effects and collapses an expanded list', () => {
        expect(statusRowSource).toContain('suppressTab?: boolean');
        expect(statusRowSource).toContain('if (!hasContent || suppressTab)');
        expect(statusRowSource).toContain('if (!suppressTab) return;');
        expect(statusRowSource).toContain('setIsExpanded(false);');

        const preloadEffect = statusRowSource.indexOf('if (!planActionState.enabled) return;');
        const autoRevealEffect = statusRowSource.indexOf('if (!shouldAutoRevealPlan) return;');
        const suppressReturn = statusRowSource.indexOf('if (!hasContent || suppressTab)');
        expect(preloadEffect).toBeGreaterThan(-1);
        expect(autoRevealEffect).toBeGreaterThan(-1);
        expect(suppressReturn).toBeGreaterThan(preloadEffect);
        expect(suppressReturn).toBeGreaterThan(autoRevealEffect);
    });
});
