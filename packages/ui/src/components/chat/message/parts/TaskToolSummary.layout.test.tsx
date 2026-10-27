import React, { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, mock, test } from 'bun:test';
import { withDom, type HostElement } from '@/test/mountedDom';

const syncModule = { ...(await import('@/sync/sync-context')) };
mock.module('@/sync/sync-context', () => ({
    ...syncModule,
    useSessionDirectory: () => undefined,
}));

mock.module('../../MarkdownRenderer', () => ({
    SimpleMarkdownRenderer: ({ content }: { content: string }) => <div data-testid="task-output">{content}</div>,
    MarkdownRenderer: ({ content }: { content: string }) => <p>{content}</p>,
}));

const { TaskToolSummary } = await import('./TaskToolSummary');
const { I18nProvider } = await import('@/lib/i18n/context');
type SummaryProps = React.ComponentProps<typeof TaskToolSummary>;

const baseProps: SummaryProps = {
    entries: [],
    isExpanded: false,
    isMobile: false,
    sessionId: 'ses_child',
    sessionAgent: 'fixer',
};

const metadata = ['<task_metadata>', 'session_id: ses_child', '</task_metadata>'].join('\n');
const specialistOutput = ['Plain result body', metadata].join('\n');

const html = (props: Partial<SummaryProps>) => renderToStaticMarkup(<I18nProvider><TaskToolSummary {...baseProps} {...props} /></I18nProvider>);

const mount = async (props: Partial<SummaryProps>, run: (container: HostElement) => Promise<void>) => {
    await withDom(async (container) => {
        const { createRoot } = await import('react-dom/client');
        const root = createRoot(container as unknown as Element);
        try {
            await act(async () => root.render(<I18nProvider><TaskToolSummary {...baseProps} {...props} /></I18nProvider>));
            await run(container);
        } finally {
            await act(async () => root.unmount());
        }
    });
};

const findButton = (container: HostElement, text: string) => container.find(
    (node) => node.tagName === 'BUTTON' && node.textContent.includes(text),
);
// The markdown renderer is mocked to emit its content verbatim in the last block of the summary.
const findOutput = (container: HostElement) => {
    const markers = ['Plain result body', '### Summary'];
    return container.find((node) => node.tagName !== 'BUTTON'
        && markers.some((marker) => node.textContent.includes(marker))
        && !node.childNodes.some((child) => 'attributes' in child && markers.some((marker) => (child as HostElement).textContent.includes(marker))));
};

describe('TaskToolSummary output layout', () => {
    test('places output below the lined task activity block', () => {
        const markup = html({ output: specialistOutput });
        const activity = markup.indexOf('Open Fixer');
        const output = markup.indexOf('>Output<');

        expect(activity).toBeGreaterThan(-1);
        expect(output).toBeGreaterThan(activity);
        // Output gets breathing room only when an activity block precedes it.
        expect(markup).toMatch(/<div class="space-y-1 pt-1"><button/);

        const outputOnly = html({ output: specialistOutput, sessionId: undefined, entries: [{ id: 'e1', tool: 'bash', state: { status: 'completed', title: 'ls' } }] });
        expect(outputOnly).toMatch(/<div class="space-y-1 pt-1"><button/);
        const noActivity = html({ output: specialistOutput, sessionId: undefined });
        expect(noActivity).toMatch(/<div class="space-y-1"><button/);
    });

    test('uses click expansion instead of a hover popover for output details', async () => {
        const markup = html({ output: specialistOutput });
        const buttonClass = markup.match(/<button type="button" class="([^"]*inline-flex items-center gap-1\.5[^"]*)"/)?.[1] ?? '';

        expect(buttonClass).not.toBe('');
        expect(buttonClass).not.toContain('hover:');
        expect(buttonClass).not.toContain('w-full');
        expect(buttonClass).not.toMatch(/(^|\s)ml-/);

        await mount({ output: specialistOutput }, async (container) => {
            expect(findOutput(container)).toBeNull();
            await act(async () => { findButton(container, 'Output')?.click(); });
            expect(findOutput(container)?.textContent).toBe('Plain result body');
            await act(async () => { findButton(container, 'Output')?.click(); });
            expect(findOutput(container)).toBeNull();
        });
    });

    test('formats specialist output after stripping task metadata', async () => {
        const specialist = [
            '<summary>Fixed the layout</summary>',
            '<changes>- one file</changes>',
            '<verification>- tests pass</verification>',
            '<status>complete</status>',
            metadata,
        ].join('\n');
        await mount({ output: specialist }, async (container) => {
            await act(async () => { findButton(container, 'Output')?.click(); });
            const text = findOutput(container)?.textContent ?? '';
            expect(text).not.toContain('task_metadata');
            expect(text).not.toContain('session_id');
            expect(text).toContain('### Summary');
            expect(text).toContain('Fixed the layout');
            expect(text).toContain('**Status:** complete');
            expect(text).not.toContain('<summary>');
        });
    });

    test('shows the authoritative task model as quiet metadata', () => {
        const markup = html({ output: specialistOutput, input: { model: { id: 'gpt-5.5', providerID: 'openai' } } });
        const badge = markup.match(/<div class="([^"]*)" title="([^"]+)">([^<]+)<\/div>/);

        expect(badge).not.toBeNull();
        expect(badge?.[1]).toContain('typography-micro text-muted-foreground/60');
        expect(badge?.[1]).not.toContain('font-mono');
        expect(badge?.[3]).toBe(badge?.[2]);
        expect(html({ output: specialistOutput })).not.toContain('typography-micro text-muted-foreground/60');
    });

    test('marks failed output partial and keeps the failure reason visible', () => {
        const failed = html({ output: specialistOutput, error: 'Provider exploded', status: 'error' });
        const completed = html({ output: specialistOutput, status: 'completed' });

        expect(failed).toContain('Partial Output');
        expect(failed).toContain('Provider exploded');
        expect(failed).toContain('var(--status-error)');
        expect(completed).toContain('>Output<');
        expect(completed).not.toContain('Partial Output');

        const statusOnly = html({ output: specialistOutput, status: 'cancelled' });
        expect(statusOnly).toContain('Partial Output');
        expect(statusOnly).toContain('Task ended before completion');
    });
});
