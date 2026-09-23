import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { CompactionTurn } from './CompactionTurn';
import type { ChatMessageEntry, Turn } from './lib/turns/types';

const message = (id: string, info: Record<string, unknown>): ChatMessageEntry => ({
    info: { id, sessionID: 'ses', role: 'assistant', ...info },
    parts: [],
} as unknown as ChatMessageEntry);

const turn = (assistantMessages: ChatMessageEntry[]): Turn => ({
    turnId: 'turn_compact',
    userMessage: message('msg_compact', { role: 'user', clientRole: 'user', clientCompaction: { kind: 'automatic' } }),
    assistantMessages,
});

const render = (value: Turn, kind: 'automatic' | 'manual' = 'automatic') => renderToStaticMarkup(
    <I18nProvider>
        <CompactionTurn turn={value} kind={kind} renderAssistant={(entry) => <div data-summary-row={entry.info.id}>summary body</div>} />
    </I18nProvider>,
);

describe('CompactionTurn', () => {
    test('a completed summary is a collapsed divider without rendering its body', () => {
        const html = render(turn([message('msg_summary', { summary: true, time: { created: 1, completed: 2 } })]));
        expect(html).toContain('data-compaction-boundary="automatic"');
        expect(html).toContain('data-turn-id="turn_compact"');
        expect(html).toContain('Context automatically compacted');
        expect(html).toContain('Show Summary');
        expect(html).not.toContain('summary body');
        expect(html).not.toContain('/compact');
    });

    test('a streaming summary shows progress and no toggle or body', () => {
        const html = render(turn([message('msg_summary', { summary: true, time: { created: 1 } })]), 'manual');
        expect(html).toContain('Compacting context…');
        expect(html).not.toContain('Show Summary');
        expect(html).not.toContain('summary body');
    });

    test('a failed summary keeps its error visible', () => {
        const html = render(turn([message('msg_summary', { summary: true, time: { created: 1, completed: 2 },
            error: { name: 'APIError', data: { message: 'context too large' } } })]), 'manual');
        expect(html).toContain('Context compacted');
        expect(html).toContain('data-summary-row="msg_summary"');
        expect(html).not.toContain('Show Summary');
    });
});
