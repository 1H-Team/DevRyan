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

    test('renders the status label once, with no decorative copy', () => {
        const html = renderToStaticMarkup(React.createElement(StatusShimmerText, {
            text: 'Waiting for subagent output',
            shouldAnimate: true,
        }));

        expect(html).toContain('data-animation-state="running"');
        expect(html).toContain('data-live-status-shimmer="true"');
        expect(html).toContain('>Waiting for subagent output</span>');
        expect(html.match(/Waiting for subagent output/g)).toHaveLength(1);
    });

    test('brightens live status on the shared tick instead of an infinite animation', () => {
        // CSS has no runtime in bun:test; the stylesheet text is the contract.
        const styles = readFileSync(new URL('../../../../index.css', import.meta.url), 'utf8');
        const shimmerRules = styles.slice(
            styles.indexOf('.oc-text-shimmer {'),
            styles.indexOf('/* The desktop shell reports a hidden or minimized window'),
        );

        expect(shimmerRules).toContain('--oc-shimmer-highlight: color-mix(in oklch, var(--foreground) 92%, transparent);');
        expect(shimmerRules).toContain('html[data-tick-blink="on"] .oc-text-shimmer[data-animation-state="running"] {');
        expect(shimmerRules).not.toMatch(/\banimation(-[a-z]+)?:/);
        expect(styles).not.toContain('@keyframes oc-text-shimmer');
    });

    test('keeps reduced-motion and hidden status static and readable', async () => {
        const html = renderToStaticMarkup(React.createElement(StatusShimmerText, {
            text: 'Reading files',
            shouldAnimate: false,
        }));
        expect(html).toContain('data-animation-state="paused"');
        expect(html).toContain('>Reading files</span>');

        await mountPlaceholder(working, async () => {
            // A visible animated status holds the shared tick.
            expect(globalThis.document.documentElement.getAttribute('data-tick-blink')).toBe('on');
        });
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
