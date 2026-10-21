import { readFileSync } from 'node:fs';
import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { withDom, type HostElement } from '../../../bots/chat/botMountedDom';
import { StatusShimmerText, WorkingPlaceholder } from './WorkingPlaceholder';

type PlaceholderProps = React.ComponentProps<typeof WorkingPlaceholder>;

const mountPlaceholder = async (
    initial: PlaceholderProps,
    run: (api: {
        container: HostElement;
        rerender: (next: PlaceholderProps) => Promise<void>;
    }) => Promise<void>,
) => {
    await withDom(async (container) => {
        const { createRoot } = await import('react-dom/client');
        const root = createRoot(container as unknown as Element);
        const rerender = async (next: PlaceholderProps) => {
            await act(async () => root.render(React.createElement(WorkingPlaceholder, next)));
        };
        try {
            await rerender(initial);
            await run({ container, rerender });
        } finally {
            await act(async () => root.unmount());
        }
    });
};

const working: PlaceholderProps = { isWorking: true, statusText: 'reading files' };
const statusRegion = (container: HostElement) => container.find((node) => node.getAttribute('role') === 'status');
const shimmers = (container: HostElement) => {
    const found: HostElement[] = [];
    const walk = (node: HostElement) => {
        if (node.getAttribute('data-live-status-shimmer') === 'true') found.push(node);
        for (const child of node.childNodes) if ('attributes' in child) walk(child as HostElement);
    };
    walk(container);
    return found;
};

afterEach(() => setSystemTime());

describe('WorkingPlaceholder status presentation', () => {
    test('uses shimmering text without the legacy trailing dots', async () => {
        await mountPlaceholder(working, async ({ container, rerender }) => {
            expect(shimmers(container)).toHaveLength(1);
            expect(container.textContent).toBe('Reading files');
            expect(container.textContent).not.toContain('...');

            await rerender({ isWorking: true, statusText: null, retryInfo: { attempt: 2, message: 'Rate limited' } });
            expect(shimmers(container)).toHaveLength(1);
            expect(container.textContent).toContain('Retrying (attempt 2)');
            expect(container.textContent).toContain('Rate limited');
            expect(container.textContent).not.toContain('...');
        });
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

    test('keeps the gradient sweep decorative so the status is announced only once', () => {
        // CSS has no runtime in bun:test; the stylesheet text is the contract.
        const styles = readFileSync(new URL('../../../../index.css', import.meta.url), 'utf8');
        const shimmerRule = styles.slice(
            styles.indexOf('@keyframes oc-text-shimmer'),
            styles.indexOf('@keyframes oc-file-mention-marquee'),
        );

        expect(shimmerRule).toContain('animation: oc-text-shimmer 2.2s linear infinite;');
        expect(shimmerRule).toContain('--oc-shimmer-highlight: color-mix(in oklch, var(--foreground) 92%, transparent);');
        expect(shimmerRule).toContain('content: attr(data-shimmer-text) / "";');
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

    test('keeps the live region and visual label mounted without keyed layout transitions', async () => {
        await mountPlaceholder(working, async ({ container, rerender }) => {
            const region = statusRegion(container);
            const shimmer = shimmers(container)[0];
            expect(region).not.toBeNull();
            expect(region?.contains(shimmer)).toBe(true);

            // Past the minimum display time the new label replaces the old one in place.
            setSystemTime(new Date(Date.now() + 5_000));
            await rerender({ isWorking: true, statusText: 'editing files' });

            expect(container.textContent).toBe('Editing files');
            expect(statusRegion(container)).toBe(region);
            expect(shimmers(container)[0]).toBe(shimmer);
        });
    });
});
