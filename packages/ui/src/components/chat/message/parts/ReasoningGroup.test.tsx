import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, mock, test } from 'bun:test';
import type { Part } from '@opencode-ai/sdk/v2';

mock.module('motion/react', () => ({
    AnimatePresence: ({ children }: React.PropsWithChildren) => <>{children}</>,
    motion: {
        div: ({
            children,
            initial: _initial,
            animate: _animate,
            exit: _exit,
            transition: _transition,
            ...props
        }: React.PropsWithChildren<Record<string, unknown>>) => {
            void _initial;
            void _animate;
            void _exit;
            void _transition;
            return <div {...props}>{children}</div>;
        },
    },
    useReducedMotion: () => false,
}));

mock.module('../../MarkdownRenderer', () => ({
    MarkdownRenderer: ({ content }: { content: string }) => <p>{content}</p>,
}));

mock.module('@/stores/useUIStore', () => ({
    useUIStore: (selector: (state: { chatRenderMode: 'live' }) => unknown) => selector({ chatRenderMode: 'live' }),
}));

const { default: ReasoningGroup } = await import('./ReasoningGroup');

const reasoningPart = (id: string, text: string, active = false): Part => ({
    id,
    messageID: 'message-1',
    sessionID: 'session-1',
    type: 'reasoning',
    text,
    time: active ? { start: 1_000 } : { start: 1_000, end: 2_000 },
} as Part);

const renderGroup = (parts: Part[]): string => renderToStaticMarkup(
    <ReasoningGroup
        entries={parts.map((part) => ({ part, messageId: 'message-1' }))}
        providerID="openai"
    />,
);

describe('ReasoningGroup', () => {
    test('keeps the single-entry case pixel-equivalent with no disclosure affordance', () => {
        const html = renderGroup([reasoningPart('reasoning-1', 'Only line.')]);

        expect(html).toContain('Only line.');
        expect(html).not.toContain('data-reasoning-group');
        expect(html).not.toContain('<button');
        expect(html.match(/data-message-text-export-root="true"/g)).toHaveLength(1);
    });

    test('collapses three entries to the latest line while preserving every export root', () => {
        const html = renderGroup([
            reasoningPart('reasoning-1', 'First line.'),
            reasoningPart('reasoning-2', 'Second line.'),
            reasoningPart('reasoning-3', 'Latest line.', true),
        ]);

        expect(html).toContain('data-reasoning-group="true"');
        expect(html).toContain('aria-hidden="true"');
        expect(html).toContain('inert=""');
        expect(html).toContain('aria-expanded="false"');
        expect(html).toContain('aria-label="Show 2 earlier reasoning lines"');
        expect(html).not.toContain('+2');
        expect(html).toContain('Latest line.');
        expect(html.match(/data-message-text-export-root="true"/g)).toHaveLength(3);
        expect(html).not.toContain('data-reasoning-shimmer');
    });

    test('keeps the disclosure state wired to expansion and collapse semantics', () => {
        const source = readFileSync(new URL('./ReasoningGroup.tsx', import.meta.url), 'utf8');

        expect(source).toContain('aria-expanded={isExpanded}');
        expect(source).toContain('onClick={() => setIsExpanded((expanded) => !expanded)}');
        expect(source).toContain("isExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'");
        expect(source).toContain('inert={!isExpanded}');
        expect(source).toContain('group-hover/reasoning:opacity-100');
    });
});
