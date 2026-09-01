import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, mock, test } from 'bun:test';
import type { Part } from '@opencode-ai/sdk/v2';

mock.module('../../MarkdownRenderer', () => ({
    MarkdownRenderer: ({ content }: { content: string }) => <p>{content}</p>,
}));

mock.module('@/stores/useUIStore', () => ({
    useUIStore: (selector: (state: { chatRenderMode: 'live' }) => unknown) => selector({ chatRenderMode: 'live' }),
}));

mock.module('@/lib/i18n', () => ({
    useI18n: () => ({
        t: (key: string, variables?: Record<string, string>) => {
            const message = ({
                'chat.reasoning.thinking': 'Thinking…',
                'chat.reasoning.thought': 'Thought',
                'chat.reasoning.thoughtFor': 'Thought for {duration}',
                'chat.reasoning.expand': 'Expand reasoning',
                'chat.reasoning.collapse': 'Collapse reasoning',
            } as Record<string, string>)[key] ?? key;
            return message.replace(/\{(\w+)\}/g, (_, name: string) => variables?.[name] ?? '');
        },
    }),
}));

const {
    default: ReasoningGroup,
    ReasoningDisclosure,
} = await import('./ReasoningGroup');
const { resolveReasoningRunActiveState } = await import('../reasoningGrouping');
const {
    formatReasoningDuration,
    getReasoningDurationMilliseconds,
} = await import('./reasoningDuration');
const { isReasoningDisclosureToggleKey } = await import('./reasoningDisclosureKeyboard');

const clippedXaiPreview = `CLIPPED${'x'.repeat(193)}...`;

const reasoningPart = ({
    id,
    text,
    start = 1_000,
    end = 2_000,
}: {
    id: string;
    text: string;
    start?: number;
    end?: number | null;
}): Part => ({
    id,
    messageID: 'message-1',
    sessionID: 'session-1',
    type: 'reasoning',
    text,
    time: end === null ? { start } : { start, end },
} as Part);

const entries = (parts: Part[]) => parts.map((part) => ({ part, messageId: 'message-1' }));

const renderGroup = (
    parts: Part[],
    options: {
        providerID?: string;
        isMessageCompleted?: boolean;
        isTrailingLiveRun?: boolean;
        isMobile?: boolean;
    } = {},
): string => renderToStaticMarkup(
    <ReasoningGroup entries={entries(parts)} providerID="openai" {...options} />,
);

describe('reasoning duration presentation', () => {
    test('formats whole seconds, minutes, and hours exactly', () => {
        expect(formatReasoningDuration(56_000)).toBe('56s');
        expect(formatReasoningDuration(95_000)).toBe('1m 35s');
        expect(formatReasoningDuration(3_723_000)).toBe('1h 2m 3s');
        expect(formatReasoningDuration(1)).toBe('1s');
        expect(formatReasoningDuration(0)).toBe('<1s');
    });

    test('uses the wall-clock span across adjacent parts, including overlap', () => {
        const groupEntries = entries([
            reasoningPart({ id: 'r1', text: 'First.', start: 10_000, end: 50_000 }),
            reasoningPart({ id: 'r2', text: 'Second.', start: 40_000, end: 105_000 }),
        ]);

        expect(getReasoningDurationMilliseconds(groupEntries)).toBe(95_000);
    });

    test('rejects missing, negative, reversed, and non-finite timing', () => {
        expect(getReasoningDurationMilliseconds(entries([
            reasoningPart({ id: 'missing', text: 'Active.', end: null }),
        ]))).toBeNull();
        expect(getReasoningDurationMilliseconds(entries([
            reasoningPart({ id: 'negative', text: 'Broken.', start: -1_000, end: 4_000 }),
        ]))).toBeNull();
        expect(getReasoningDurationMilliseconds(entries([
            reasoningPart({ id: 'reversed', text: 'Broken.', start: 5_000, end: 4_000 }),
        ]))).toBeNull();
        expect(getReasoningDurationMilliseconds(entries([
            reasoningPart({ id: 'complete', text: 'Complete.', start: 1_000, end: 2_000 }),
            reasoningPart({ id: 'incomplete', text: 'Incomplete.', start: 2_000, end: null }),
        ]))).toBeNull();
        expect(getReasoningDurationMilliseconds(entries([
            reasoningPart({ id: 'non-finite', text: 'Broken.', start: Number.POSITIVE_INFINITY, end: 4_000 }),
        ]))).toBeNull();
        expect(formatReasoningDuration(Number.NaN)).toBeNull();
        expect(formatReasoningDuration(-1)).toBeNull();
    });
});

describe('ReasoningGroup', () => {
    test('keeps only the trailing reasoning run active across ended-part gaps', () => {
        expect(resolveReasoningRunActiveState({
            isMessageCompleted: false,
            hasActivePart: false,
            isTrailingLiveRun: true,
        })).toBe(true);
        expect(resolveReasoningRunActiveState({
            isMessageCompleted: false,
            hasActivePart: false,
            isTrailingLiveRun: false,
        })).toBe(false);
        expect(resolveReasoningRunActiveState({
            isMessageCompleted: true,
            hasActivePart: true,
            isTrailingLiveRun: true,
        })).toBe(false);
    });

    test('does not flash a terminal zero-second label between adjacent live parts', () => {
        const html = renderGroup([
            reasoningPart({ id: 'reasoning-gap-1', text: 'First.', start: 1_000, end: 1_000 }),
            reasoningPart({ id: 'reasoning-gap-2', text: 'Second.', start: 1_000, end: 1_000 }),
        ], { isTrailingLiveRun: true });

        expect(html).toContain('data-reasoning-disclosure-active="true"');
        expect(html).toContain('Thinking…');
        expect(html).not.toContain('Thought for');
    });

    test('terminalizes a non-trailing ended run without reporting zero seconds', () => {
        const html = renderGroup([
            reasoningPart({ id: 'reasoning-ended-1', text: 'First.', start: 1_000, end: 1_000 }),
            reasoningPart({ id: 'reasoning-ended-2', text: 'Second.', start: 1_000, end: 1_000 }),
        ]);

        expect(html).toContain('data-reasoning-disclosure-active="false"');
        expect(html).toContain('Thought for &lt;1s');
        expect(html).not.toContain('Thought for 0s');
    });

    test('message completion wins over a stale trailing-run hint', () => {
        const html = renderGroup([
            reasoningPart({ id: 'reasoning-completed', text: 'Done.', start: 1_000, end: 17_000 }),
        ], { isMessageCompleted: true, isTrailingLiveRun: true });

        expect(html).toContain('data-reasoning-disclosure-active="false"');
        expect(html).toContain('Thought for 16s');
        expect(html).not.toContain('Thinking…');
    });

    test('recognizes the native Enter and Space activation keys only', () => {
        expect(isReasoningDisclosureToggleKey('Enter')).toBe(true);
        expect(isReasoningDisclosureToggleKey(' ')).toBe(true);
        expect(isReasoningDisclosureToggleKey('Escape')).toBe(false);
    });

    test('renders a completed short singleton inline without a disclosure label', () => {
        const html = renderGroup([
            reasoningPart({ id: 'reasoning-short', text: 'Only line.', start: 1_000, end: 13_000 }),
        ], { isMessageCompleted: true });

        expect(html).toContain('Only line.');
        expect(html).not.toContain('data-reasoning-group="true"');
        expect(html).not.toContain('aria-expanded');
        expect(html).not.toContain('Thought for');
    });

    test('keeps a singleton inline immediately below the duration threshold', () => {
        const html = renderGroup([
            reasoningPart({ id: 'reasoning-below-threshold', text: 'Still inline.', start: 1_000, end: 15_999 }),
        ], { isMessageCompleted: true });

        expect(html).toContain('Still inline.');
        expect(html).not.toContain('data-reasoning-group="true"');
    });

    test('collapses a completed singleton at the exact duration threshold', () => {
        const html = renderGroup([
            reasoningPart({ id: 'reasoning-threshold', text: 'Threshold line.', start: 1_000, end: 16_000 }),
        ], { isMessageCompleted: true });

        expect(html).toContain('data-reasoning-group="true"');
        expect(html).toContain('aria-label="Expand reasoning: Thought for 15s"');
        expect(html).not.toContain('Threshold line.');
    });

    test('collapses a completed long singleton into an exact duration disclosure', () => {
        const html = renderGroup([
            reasoningPart({ id: 'reasoning-1', text: 'Only line.', start: 1_000, end: 57_000 }),
        ], { isMessageCompleted: true });

        expect(html).toContain('data-reasoning-group="true"');
        expect(html).toContain('data-reasoning-disclosure-active="false"');
        expect(html).toContain('aria-expanded="false"');
        expect(html).toContain('aria-label="Expand reasoning: Thought for 56s"');
        expect(html).toContain('Thought for 56s');
        expect(html).not.toContain('Only line.');
    });

    test('keeps an active multi-part run compact without changing expansion state', () => {
        const html = renderGroup([
            reasoningPart({ id: 'reasoning-1', text: 'First line.', start: 1_000, end: 2_000 }),
            reasoningPart({ id: 'reasoning-2', text: 'Latest line.', start: 2_000, end: null }),
        ]);

        expect(html).toContain('data-reasoning-disclosure-active="true"');
        expect(html).toContain('aria-expanded="false"');
        expect(html).toContain('aria-label="Expand reasoning: Thinking…"');
        expect(html).toContain('Thinking…');
        expect(html).not.toContain('First line.');
        expect(html).not.toContain('Latest line.');
    });

    test('collapses two adjacent short thoughts regardless of total duration', () => {
        const html = renderGroup([
            reasoningPart({ id: 'reasoning-short-1', text: 'First short line.', start: 1_000, end: 5_000 }),
            reasoningPart({ id: 'reasoning-short-2', text: 'Second short line.', start: 5_000, end: 9_000 }),
        ], { isMessageCompleted: true });

        expect(html).toContain('data-reasoning-group="true"');
        expect(html).toContain('aria-label="Expand reasoning: Thought for 8s"');
        expect(html).not.toContain('First short line.');
        expect(html).not.toContain('Second short line.');
    });

    test('renders every entry in source order only when explicitly expanded', () => {
        const groupEntries = entries([
            reasoningPart({ id: 'reasoning-1', text: 'First line.', start: 0, end: 50_000 }),
            reasoningPart({ id: 'reasoning-2', text: 'Second line.', start: 50_000, end: 95_000 }),
        ]);
        const html = renderToStaticMarkup(
            <ReasoningDisclosure
                entries={groupEntries}
                providerID="openai"
                isMessageCompleted
                isExpanded
                onExpandedChange={() => undefined}
            />,
        );

        expect(html).toContain('aria-expanded="true"');
        expect(html).toContain('aria-label="Collapse reasoning: Thought for 1m 35s"');
        expect(html.indexOf('First line.')).toBeLessThan(html.indexOf('Second line.'));
        expect(html.match(/data-message-text-export-root="true"/g)).toHaveLength(2);
    });

    test('renders a completed singleton with incomplete timing inline', () => {
        const html = renderGroup([
            reasoningPart({ id: 'reasoning-aborted', text: 'Interrupted.', start: 1_000, end: null }),
        ], { isMessageCompleted: true });

        expect(html).toContain('Interrupted.');
        expect(html).not.toContain('data-reasoning-group="true"');
        expect(html).not.toContain('Thought');
    });

    test('falls back to Thought for a multi-part disclosure with incomplete timing', () => {
        const html = renderGroup([
            reasoningPart({ id: 'reasoning-complete', text: 'Complete.', start: 1_000, end: 2_000 }),
            reasoningPart({ id: 'reasoning-incomplete', text: 'Interrupted.', start: 2_000, end: null }),
        ], { isMessageCompleted: true });

        expect(html).toContain('aria-label="Expand reasoning: Thought"');
        expect(html).not.toContain('Thinking…');
        expect(html).not.toContain('Thought for');
    });

    test('renders an empty active reasoning shell but omits an empty terminal part', () => {
        expect(renderGroup([
            reasoningPart({ id: 'reasoning-empty-active', text: '', end: null }),
        ])).toContain('Thinking…');
        expect(renderGroup([
            reasoningPart({ id: 'reasoning-empty-terminal', text: '' }),
        ], { isMessageCompleted: true })).toBe('');
    });

    test('renders no wrapper when every entry is a clipped xAI preview', () => {
        const html = renderGroup([
            reasoningPart({ id: 'reasoning-clipped-1', text: clippedXaiPreview }),
            reasoningPart({ id: 'reasoning-clipped-2', text: clippedXaiPreview }),
        ], { providerID: 'xai', isMessageCompleted: true });

        expect(html).toBe('');
    });

    test('excludes clipped xAI previews before duration aggregation', () => {
        const html = renderGroup([
            reasoningPart({ id: 'reasoning-1', text: 'Visible line.', start: 1_000, end: 57_000 }),
            reasoningPart({ id: 'reasoning-clipped', text: clippedXaiPreview, start: 57_000, end: 200_000 }),
        ], { providerID: 'xai', isMessageCompleted: true });

        expect(html).toContain('Thought for 56s');
        expect(html).not.toContain('Visible line.');
        expect(html).not.toContain('CLIPPED');
    });

    test('does not let a clipped xAI preview turn a short singleton into a disclosure', () => {
        const html = renderGroup([
            reasoningPart({ id: 'reasoning-visible-short', text: 'Visible short line.', start: 1_000, end: 13_000 }),
            reasoningPart({ id: 'reasoning-clipped', text: clippedXaiPreview, start: 13_000, end: 200_000 }),
        ], { providerID: 'xai', isMessageCompleted: true });

        expect(html).toContain('Visible short line.');
        expect(html).not.toContain('data-reasoning-group="true"');
        expect(html).not.toContain('CLIPPED');
    });

    test('uses a full-width 44px target on mobile', () => {
        const html = renderToStaticMarkup(
            <ReasoningDisclosure
                entries={entries([reasoningPart({ id: 'reasoning-mobile', text: 'Mobile thought.' })])}
                isMessageCompleted
                isMobile
                isExpanded
                onExpandedChange={() => undefined}
            />,
        );

        expect(html).toContain('min-h-11 w-full py-2');
        expect(html).toContain('motion-reduce:transition-none');
        expect(html).toContain('motion-reduce:animate-none');
    });

    test('keeps the 44px target at narrow responsive widths without touch detection', () => {
        const html = renderToStaticMarkup(
            <ReasoningDisclosure
                entries={entries([reasoningPart({ id: 'reasoning-responsive', text: 'Responsive thought.' })])}
                isMessageCompleted
                isExpanded={false}
                onExpandedChange={() => undefined}
            />,
        );

        expect(html).toContain('max-md:min-h-11 max-md:w-full max-md:py-2');
        expect(html).toContain('group/reasoning max-md:w-full');
    });

    test('forces the disclosure panel animation off for reduced motion', () => {
        const styles = readFileSync(new URL('../../../../index.css', import.meta.url), 'utf8');
        const reducedMotionRule = styles.slice(styles.indexOf('@media (prefers-reduced-motion: reduce)', styles.indexOf('.markdown-content.markdown-reasoning')));
        const html = renderToStaticMarkup(
            <ReasoningDisclosure
                entries={entries([reasoningPart({ id: 'reduced', text: 'Reasoning.' })])}
                isMessageCompleted
                isExpanded
                onExpandedChange={() => undefined}
            />,
        );

        expect(html).toContain('data-reasoning-disclosure-content="true"');
        expect(reducedMotionRule).toContain('[data-reasoning-disclosure-content="true"]');
        expect(reducedMotionRule).toContain('animation: none !important;');
        expect(reducedMotionRule).toContain('transition: none !important;');
    });
});
