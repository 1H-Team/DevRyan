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
const { I18nProvider } = await import('@/lib/i18n/context');

const textPart = { id: 'p1', type: 'text', text: 'Done.', sessionID: 's1', messageID: 'm1', time: { start: 1, end: 2 } } as unknown as Part;
const turn: TurnGroupingContext = {
    turnId: 'turn_1',
    isFirstAssistantInTurn: true,
    isLastAssistantInTurn: true,
    hasTools: false,
    hasReasoning: false,
    isWorking: false,
    isTurnWorking: false,
    userMessageCreatedAt: 1_700_000_000_000,
};

const renderFooter = () => renderToStaticMarkup(
    <I18nProvider>
        <MessageBody
            sessionId="s1"
            messageId="m1"
            parts={[textPart]}
            isUser={false}
            isMessageCompleted
            messageFinish="stop"
            messageCreatedAt={1_700_000_001_000}
            messageCompletedAt={1_700_000_065_000}
            hasTextContent
            syntaxTheme={{}}
            isMobile={false}
            copiedCode={null}
            onCopyCode={() => undefined}
            expandedTools={new Set()}
            onToggleTool={() => undefined}
            onShowPopup={() => undefined}
            streamPhase="completed"
            allowAnimation={false}
            turnGroupingContext={turn}
        />
    </I18nProvider>,
);

describe('MessageBody footer metadata', () => {
    test('renders the completion time before the turn duration', () => {
        const html = renderFooter();
        const timestamp = html.indexOf('aria-label="Message time:');
        const labels = [...html.matchAll(/<span class="message-footer__label">([^<]+)<\/span>/g)].map((match) => match[1]);

        expect(timestamp).toBeGreaterThan(-1);
        expect(labels).toHaveLength(2);
        // Second label is the duration (1m 4s between user message and completion).
        expect(labels[1]).toMatch(/1m/);
        expect(html.indexOf(`>${labels[0]}<`)).toBeLessThan(html.indexOf(`>${labels[1]}<`));
        expect(html.indexOf('aria-label="Message time:')).toBeLessThan(html.indexOf(`>${labels[1]}<`));
    });

    test('does not append workspace evidence beside the turn duration', () => {
        const html = renderFooter();

        expect(html).toContain('message-footer__label');
        expect(html).not.toContain('Workspace Changes Observed During This Turn');
    });

    test('keeps the timing group close to the message actions', () => {
        const html = renderFooter();
        const footer = html.match(/<div class="flex items-center justify-start gap-3"[^>]*>(.*)$/s)?.[1] ?? '';

        expect(footer).toMatch(/^<div class="flex items-center gap-1\.5" data-message-action-group="true">/);
        // The timing group is the direct sibling that follows the action group.
        expect(footer).toMatch(/<\/div><div class="flex items-center gap-1\.5"><span[^>]*aria-label="Message time:/);
    });
});
