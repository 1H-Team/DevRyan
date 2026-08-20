import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'bun:test';
import { StatusShimmerText } from './WorkingPlaceholder';

const source = readFileSync(new URL('./WorkingPlaceholder.tsx', import.meta.url), 'utf8');

describe('WorkingPlaceholder status presentation', () => {
    test('uses shimmering text without the legacy trailing dots', () => {
        expect(source).not.toContain('BusyDots');
        expect(source).not.toContain("`${retryText}...`");
        expect(source.match(/<StatusShimmerText/g)?.length ?? 0).toBe(2);
    });

    test('keeps one accessible label in flow beneath an aligned visual duplicate', () => {
        const html = renderToStaticMarkup(React.createElement(StatusShimmerText, {
            text: 'Waiting for subagent output',
            shouldAnimate: true,
        }));

        expect(html).toContain('data-animation-state="running"');
        expect(html).toContain('data-live-status-shimmer="true"');
        expect(html).toContain('<span class="oc-live-status-shimmer__label">Waiting for subagent output</span>');
        expect(html).toContain('<span aria-hidden="true" class="oc-live-status-shimmer__focus">');
        expect(html.match(/Waiting for subagent output/g)).toHaveLength(2);
    });

    test('uses visible foreground contrast with compositor-only counter-transforms', () => {
        const styles = readFileSync(new URL('../../../../index.css', import.meta.url), 'utf8');
        const shimmerRule = styles.slice(
            styles.indexOf('@keyframes oc-live-status-focus'),
            styles.indexOf('@keyframes oc-file-mention-marquee'),
        );

        expect(shimmerRule).toContain('animation: oc-live-status-focus 2.2s linear infinite;');
        expect(shimmerRule).toContain('animation: oc-live-status-focus-counter 2.2s linear infinite;');
        expect(shimmerRule).toContain('--oc-live-status-highlight: var(--foreground);');
        expect(shimmerRule).toContain('color: var(--oc-live-status-highlight);');
        expect(shimmerRule).toContain('translate3d(100%, 0, 0)');
        expect(shimmerRule).toContain('translate3d(-100%, 0, 0)');
        expect(shimmerRule).toContain('will-change: transform;');
        expect(shimmerRule).not.toContain('background-position');
        expect(shimmerRule).not.toContain('background-clip');
    });

    test('retains readable status text when reduced motion disables shimmer', () => {
        const styles = readFileSync(new URL('../../../../index.css', import.meta.url), 'utf8');
        const reducedMotionRule = styles.slice(styles.lastIndexOf('@media (prefers-reduced-motion: reduce)'));

        expect(reducedMotionRule).toContain('.oc-live-status-shimmer__focus');
        expect(reducedMotionRule).toContain('animation: none;');
        expect(reducedMotionRule).toContain('opacity: 0;');
    });

    test('keeps the live region and visual label mounted without keyed layout transitions', () => {
        const statusWrapper = source.indexOf('role="status"', source.indexOf('const label ='));
        const shimmer = source.indexOf('<StatusShimmerText', statusWrapper);

        expect(statusWrapper).toBeGreaterThan(-1);
        expect(shimmer).toBeGreaterThan(statusWrapper);
        expect(source).not.toContain('AnimatePresence');
        expect(source).not.toContain('motion.span');
        expect(source).not.toContain('key={label}');
    });
});
