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

    test('keeps one accessible label in flow beneath the visual shimmer layer', () => {
        const html = renderToStaticMarkup(React.createElement(StatusShimmerText, {
            text: 'Waiting for subagent output',
            shouldAnimate: true,
        }));

        expect(html).toContain('data-animation-state="running"');
        expect(html).toContain('data-live-status-shimmer="true"');
        expect(html).toContain('data-shimmer-text="Waiting for subagent output"');
        expect(html).toContain('>Waiting for subagent output</span>');
        expect(html.match(/Waiting for subagent output/g)).toHaveLength(2);
    });

    test('restores the visible gradient text sweep from the prior implementation', () => {
        const styles = readFileSync(new URL('../../../../index.css', import.meta.url), 'utf8');
        const shimmerRule = styles.slice(
            styles.indexOf('@keyframes oc-text-shimmer'),
            styles.indexOf('@keyframes oc-file-mention-marquee'),
        );

        expect(shimmerRule).toContain('animation: oc-text-shimmer 2.2s linear infinite;');
        expect(shimmerRule).toContain('--oc-shimmer-highlight: color-mix(in oklch, var(--foreground) 92%, transparent);');
        expect(shimmerRule).toContain('content: attr(data-shimmer-text);');
        expect(shimmerRule).toContain('background-position: 200% 0;');
        expect(shimmerRule).toContain('background-position: -200% 0;');
        expect(shimmerRule).toContain('background-clip: text;');
    });

    test('retains readable status text when reduced motion disables shimmer', () => {
        const styles = readFileSync(new URL('../../../../index.css', import.meta.url), 'utf8');
        const reducedMotionRule = styles.slice(styles.lastIndexOf('@media (prefers-reduced-motion: reduce)'));

        expect(reducedMotionRule).toContain('.oc-text-shimmer::after');
        expect(reducedMotionRule).toContain('content: none;');
        expect(reducedMotionRule).toContain('animation: none;');
        expect(reducedMotionRule).toContain('background-image: none;');
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
