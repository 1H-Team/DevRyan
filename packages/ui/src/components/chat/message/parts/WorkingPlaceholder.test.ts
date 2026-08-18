import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const source = readFileSync(new URL('./WorkingPlaceholder.tsx', import.meta.url), 'utf8');

describe('WorkingPlaceholder status presentation', () => {
    test('uses shimmering text without the legacy trailing dots', () => {
        expect(source).not.toContain('BusyDots');
        expect(source).not.toContain("`${retryText}...`");
        expect(source.match(/oc-text-shimmer/g)?.length ?? 0).toBeGreaterThan(1);
    });

    test('keeps the base text visible beneath the moving highlight', () => {
        const styles = readFileSync(new URL('../../../../index.css', import.meta.url), 'utf8');
        const shimmerRule = styles.slice(
            styles.indexOf('.oc-text-shimmer {'),
            styles.indexOf('@keyframes oc-file-mention-marquee'),
        );

        expect(source.match(/data-shimmer-text=/g)?.length ?? 0).toBe(2);
        expect(shimmerRule).toContain('color: var(--oc-shimmer-base);');
        expect(shimmerRule).toContain('-webkit-text-fill-color: currentColor;');
        expect(shimmerRule).toContain('.oc-text-shimmer::after');
        expect(shimmerRule).toContain('content: attr(data-shimmer-text);');
    });

    test('retains readable status text when reduced motion disables shimmer', () => {
        const styles = readFileSync(new URL('../../../../index.css', import.meta.url), 'utf8');
        const reducedMotionRule = styles.slice(styles.lastIndexOf('@media (prefers-reduced-motion: reduce)'));

        expect(reducedMotionRule).toContain('.oc-text-shimmer::after');
        expect(reducedMotionRule).toContain('content: none;');
        expect(reducedMotionRule).toContain('animation: none;');
        expect(reducedMotionRule).toContain('background-image: none;');
    });

    test('keeps the live region stable while only the visual label swaps', () => {
        const statusWrapper = source.indexOf('role="status"', source.indexOf('const label ='));
        const presence = source.indexOf('<AnimatePresence mode="popLayout" initial={false}>', statusWrapper);
        const keyedLabel = source.indexOf('key={label}', presence);

        expect(statusWrapper).toBeGreaterThan(-1);
        expect(presence).toBeGreaterThan(statusWrapper);
        expect(keyedLabel).toBeGreaterThan(presence);
        expect(source).toContain('<span className="sr-only">{label}</span>');
        expect(source).toContain('aria-hidden="true"');
    });
});
