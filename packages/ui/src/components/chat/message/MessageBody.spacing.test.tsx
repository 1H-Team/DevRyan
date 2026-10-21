import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, mock, test } from 'bun:test';
import type { TurnGroupingContext } from '../lib/turns/types';

const syncModule = { ...(await import('@/sync/sync-context')) };
mock.module('@/sync/sync-context', () => ({
    ...syncModule,
    useSessionDirectory: () => undefined,
    useSession: () => undefined,
}));
const markdownModule = { ...(await import('../MarkdownRenderer')) };
mock.module('../MarkdownRenderer', () => ({
    ...markdownModule,
    MarkdownRenderer: ({ content }: { content: string }) => <p>{content}</p>,
    SimpleMarkdownRenderer: ({ content }: { content: string }) => <p>{content}</p>,
}));
mock.module('@/hooks/useProviderLogo', () => ({
    useProviderLogo: () => ({ hasLogo: false, src: null, onError: () => undefined }),
}));

const { default: MessageBody } = await import('./MessageBody');
const { default: ProgressiveGroup } = await import('./parts/ProgressiveGroup');
const { I18nProvider } = await import('@/lib/i18n/context');

const testDir = dirname(fileURLToPath(import.meta.url));
const read = (path: string): string => readFileSync(resolve(testDir, path), 'utf8');

const part = (value: Record<string, unknown>) => ({ sessionID: 's1', messageID: 'm1', time: { start: 1, end: 2 }, ...value }) as unknown as Part;
const textPart = (id: string, text: string) => part({ id, type: 'text', text });
const reasoningPart = part({ id: 'r1', type: 'reasoning', text: 'Some reasoning here' });
const toolPart = (tool: string) => part({
    id: `tool_${tool}`,
    type: 'tool',
    tool,
    callID: `call_${tool}`,
    state: { status: 'completed', input: {}, output: 'x', title: tool, metadata: {}, time: { start: 1, end: 2 } },
});

const finalTurn: TurnGroupingContext = {
    turnId: 'turn_1',
    isFirstAssistantInTurn: true,
    isLastAssistantInTurn: true,
    hasTools: false,
    hasReasoning: false,
    isWorking: false,
    isTurnWorking: false,
};

const render = (parts: Part[], overrides: Partial<React.ComponentProps<typeof MessageBody>> = {}) => renderToStaticMarkup(
    <I18nProvider>
        <MessageBody
            sessionId="s1"
            messageId="m1"
            parts={parts}
            isUser={false}
            isMessageCompleted
            syntaxTheme={{}}
            isMobile={false}
            copiedCode={null}
            onCopyCode={() => undefined}
            expandedTools={new Set()}
            onToggleTool={() => undefined}
            onShowPopup={() => undefined}
            streamPhase="completed"
            allowAnimation={false}
            showReasoningTraces
            {...overrides}
        />
    </I18nProvider>,
);

const stackClass = (html: string) => html.match(/<div class="([^"]*)" data-session-output-stack="true"/)?.[1] ?? '';

describe('session output spacing', () => {
    test('centralizes the top-level vertical rhythm in MessageBody', () => {
        const desktop = stackClass(render([textPart('p1', 'Hello')]));
        const mobile = stackClass(render([textPart('p1', 'Hello')], { isMobile: true }));

        expect(desktop).toContain('message-content-text flex flex-col leading-relaxed');
        expect(desktop).toContain('gap-y-3');
        expect(mobile).toContain('gap-y-2');
        expect(mobile).not.toContain('gap-y-3');
        // The stack only needs horizontal containment. `overflow-hidden` clipped the
        // Agent Dispatch card's 1px bottom border whenever the turn continued below it
        // and, on mobile, matched the blanket `.overflow-hidden { overflow-y: auto }` rule.
        expect(desktop).toContain('overflow-x-clip text-foreground/90');
        expect(desktop).not.toContain('overflow-hidden');
        expect(mobile).not.toContain('overflow-hidden');

        const footer = render([textPart('p1', 'Hello')], {
            messageFinish: 'stop',
            hasTextContent: true,
            turnGroupingContext: finalTurn,
        });
        expect(footer).toContain('<div class="flex items-center justify-start gap-3"');
        expect(footer).not.toContain('mt-2 mb-1 flex items-center justify-start gap-3');
        // Exterior markdown edge-margins are stripped via scoped CSS, not utilities on the stack.
        expect(desktop).not.toContain('[&_p:last-child]:mb-0');
    });

    test('keeps layout pins that no render path reaches without a live chat container', () => {
        const source = read('MessageBody.tsx');
        // Source contracts: these need the full managed-task / chat-container runtime to render.
        const stackMarker = source.indexOf('data-session-output-stack="true"');
        const managedTaskList = source.lastIndexOf('<ManagedTaskList');
        expect(stackMarker).toBeGreaterThan(-1);
        expect(managedTaskList).toBeGreaterThan(stackMarker);
        expect(source.indexOf('\n            </div>\n        </div>\n    );', managedTaskList)).toBeGreaterThan(managedTaskList);
        expect(source).toContain('const STACKED_MESSAGE_ACTIONS_CLASS_NAME = \'flex items-center justify-start gap-1.5\'');
        expect(source).not.toContain('key={`progressive-group-${segment.id}`} className="mb-3"');

        const toolPart = read('parts/ToolPart.tsx');
        const planCard = read('parts/PlanCard.tsx');
        expect(toolPart).toContain("'group/tool flex gap-1.5 pr-2 pl-px py-1.5 rounded-xl'");
        expect(planCard).not.toContain('className="my-4 overflow-hidden rounded-xl');
        expect(planCard).toContain('className="overflow-hidden rounded-xl border border-border bg-card"');
    });

    test('uses the same full rhythm step at the live status boundary after dispatch cards', () => {
        const source = read('../ChatContainer.tsx');

        expect(source).toContain("isMobile ? 'mt-3' : 'mt-4'");
        expect(source).toContain("'mb-3 min-h-[1.45rem]'");
        expect(source).not.toContain("isMobile ? 'mt-2' : 'mt-3'");
        expect(source).not.toContain("isMobile ? 'mt-1.5' : 'mt-2'");
    });

    test('uses the same rhythm for rendered assistant continuation messages only', () => {
        const message = read('../ChatMessage.tsx');
        const css = read('../../../index.css');

        expect(message).toContain("isContinuationAssistant && 'assistant-continuation-spacing'");
        expect(css).toContain('.assistant-continuation-spacing:has([data-session-output-stack="true"] > *)');
        expect(css).toContain('padding-top: 0.75rem;');
        expect(css).toContain('.device-mobile .assistant-continuation-spacing');
        expect(css).toContain('padding-top: 0.5rem;');
    });

    test('flattens markdown exterior margins inside the session output stack', () => {
        const css = read('../../../index.css');

        expect(css).toContain('[data-session-output-stack="true"] .markdown-content > :first-child');
        expect(css).toContain('[data-session-output-stack="true"] .markdown-content > :last-child');
    });

    test('keeps Live and Sorted assistant text on the same exterior-spacing contract', () => {
        const desktop = render([textPart('p1', 'Hello')]);
        const mobile = render([textPart('p1', 'Hello')], { isMobile: true });

        // Assistant text shares the same symmetric row padding as reasoning/tool rows.
        expect(desktop).toContain('<div class="group/assistant-text relative break-words py-1.5">');
        expect(mobile).toContain('<div class="group/assistant-text relative break-words py-1">');
        expect(desktop).not.toContain(' my-1');
        expect(desktop).not.toContain('mt-3 break-words max-w-full');
    });

    test('removes child-owned exterior margins and shares symmetric row padding', () => {
        const desktop = render([reasoningPart, toolPart('edit'), toolPart('mytool')]);
        const mobile = render([reasoningPart], { isMobile: true });

        // The reasoning block owns its responsive row padding and no exterior margin.
        expect(desktop).toContain('data-reasoning-block-id="r1"');
        expect(desktop).toContain('<div class="relative pr-2 py-1.5">');
        expect(mobile).toContain('<div class="relative pr-2 py-1">');
        expect(desktop).not.toContain('class="my-1"');
        expect(desktop).not.toContain('class="my-1 typography-meta text-muted-foreground"');

        // Grouped activity rows and static tool rows share the same symmetric padding.
        expect(desktop).toContain('class="group/tool flex w-full items-center gap-x-1.5 pr-2 pl-px py-1.5 rounded-xl text-left min-w-0"');
        expect(desktop).toContain('class="flex w-full items-center gap-x-1.5 pr-2 pl-px py-1.5 rounded-xl min-w-0"');
    });

    test('progressive group rows use the responsive vertical rhythm without exterior margins', () => {
        const activity = [{
            id: 'a1',
            turnId: 'turn_1',
            messageId: 'm1',
            partIndex: 0,
            kind: 'reasoning' as const,
            part: reasoningPart,
        }];
        const group = (isMobile: boolean, showHeader: boolean) => renderToStaticMarkup(
            <I18nProvider>
                <ProgressiveGroup
                    parts={activity}
                    isExpanded
                    onToggle={() => undefined}
                    syntaxTheme={{}}
                    isMobile={isMobile}
                    expandedTools={new Set()}
                    onToggleTool={() => undefined}
                    onShowPopup={() => undefined}
                    streamPhase="completed"
                    showHeader={showHeader}
                    animateRows={false}
                />
            </I18nProvider>,
        );

        for (const showHeader of [false, true]) {
            expect(group(false, showHeader)).toContain('<div class="space-y-3">');
            expect(group(true, showHeader)).toContain('<div class="space-y-2">');
            expect(group(false, showHeader)).not.toContain('mt-1 mb-2');
        }
    });
});

describe('assistant part projection', () => {
    test('renders from the shared projection instead of an inlined filter chain', () => {
        // ChatMessage decides header visibility from the same projection. If MessageBody
        // re-inlines its own filter the two answers diverge and empty rows regain headers.
        const html = render([textPart('empty', ''), textPart('blank', '   \n'), textPart('real', 'Visible answer')]);

        expect(html.match(/group\/assistant-text/g)).toHaveLength(1);
        expect(html).toContain('Visible answer');
    });
});
