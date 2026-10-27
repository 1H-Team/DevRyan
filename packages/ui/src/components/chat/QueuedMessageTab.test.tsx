import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import type { QueuedMessage } from '@/stores/messageQueueStore';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

// The connected wrapper reads session activity from the sync provider; the
// phase is the only thing this file needs to control.
let mockedPhase = 'busy';
mock.module('@/hooks/useSessionActivity', () => ({
    useCurrentSessionActivity: () => ({ phase: mockedPhase, isWorking: true, isBusy: true, isCooldown: false }),
}));

const { QueuedMessageRow, QueuedMessageTabView, QueuedMessageTab } = await import('./QueuedMessageTab');

const queued = (
    id: string,
    content: string,
    attachments?: QueuedMessage['attachments'],
): QueuedMessage => ({
    id,
    content,
    createdAt: 1,
    attachments,
});

type ButtonElement = React.ReactElement<{
    'aria-label'?: string;
    onClick?: () => void;
    children?: React.ReactNode;
}>;

function collectButtons(node: React.ReactNode): ButtonElement[] {
    const buttons: ButtonElement[] = [];
    const visit = (value: React.ReactNode) => {
        if (value == null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') {
            return;
        }
        if (Array.isArray(value)) {
            value.forEach(visit);
            return;
        }
        if (!React.isValidElement(value)) return;
        if (value.type === 'button') buttons.push(value as ButtonElement);
        visit((value.props as { children?: React.ReactNode }).children);
    };
    visit(node);
    return buttons;
}

function renderTab(
    queuedMessages: QueuedMessage[],
    sessionPhase: string,
    onSend: (message: QueuedMessage) => void = () => undefined,
    onRemove: (messageId: string) => void = () => undefined,
) {
    return renderToStaticMarkup(
        <I18nProvider>
            <QueuedMessageTabView
                tabBackground="#222222"
                queuedMessages={queuedMessages}
                sessionPhase={sessionPhase}
                onEdit={() => undefined}
                onSend={onSend}
                onRemove={onRemove}
            />
        </I18nProvider>,
    );
}

describe('QueuedMessageTab', () => {
    test('renders one row per queued message', () => {
        const html = renderTab(
            [queued('q1', 'First queued prompt'), queued('q2', 'Second queued prompt')],
            'busy',
        );
        expect(html).toContain('First queued prompt');
        expect(html).toContain('Second queued prompt');
        expect(html.match(/First queued prompt/g)).toHaveLength(1);
        expect(html.match(/Second queued prompt/g)).toHaveLength(1);
    });

    test('Steer calls onSendMessage with that message', () => {
        const message = queued('q1', 'Steer this turn');
        let sent: QueuedMessage | undefined;
        const element = QueuedMessageRow({
            message,
            sendLabel: 'Steer',
            sendAria: 'Steer Conversation',
            emptyLabel: '(empty)',
            editAria: 'Edit Queued Message',
            removeAria: 'Remove from Queue',
            showSteerIcon: true,
            onEdit: () => undefined,
            onSend: (next) => {
                sent = next;
            },
            onRemove: () => undefined,
        });

        const steer = collectButtons(element).find(
            (button) => button.props['aria-label'] === 'Steer Conversation',
        );
        if (!steer?.props.onClick) throw new Error('expected Steer button');
        steer.props.onClick();

        expect(sent).toEqual(message);
    });

    test('shows the steering icon only while a turn is abortable', () => {
        const row = (showSteerIcon: boolean) => renderToStaticMarkup(
            <>{QueuedMessageRow({
                message: queued('q1', 'Icon check'),
                sendLabel: 'Steer',
                sendAria: 'Steer Conversation',
                emptyLabel: '(empty)',
                editAria: 'Edit Queued Message',
                removeAria: 'Remove from Queue',
                showSteerIcon,
                onEdit: () => undefined,
                onSend: () => undefined,
                onRemove: () => undefined,
            })}</>,
        );
        const sendButton = (html: string) => html.match(/<button[^>]*aria-label="Steer Conversation"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? '';
        expect(sendButton(row(true))).toContain('<svg');
        expect(sendButton(row(false))).not.toContain('<svg');
        const editButton = row(true).match(/<button[^>]*aria-label="Edit Queued Message"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? '';
        expect(editButton).toContain('<svg');
    });

    test('edit icon calls onEdit with that message', () => {
        const message = queued('q-edit', 'Revise this row');
        let edited: QueuedMessage | undefined;
        const element = QueuedMessageRow({
            message,
            sendLabel: 'Steer',
            sendAria: 'Steer Conversation',
            emptyLabel: '(empty)',
            editAria: 'Edit Queued Message',
            removeAria: 'Remove from Queue',
            showSteerIcon: true,
            onEdit: (next) => {
                edited = next;
            },
            onSend: () => undefined,
            onRemove: () => undefined,
        });
        const edit = collectButtons(element).find(
            (button) => button.props['aria-label'] === 'Edit Queued Message',
        );
        if (!edit?.props.onClick) throw new Error('expected edit button');
        edit.props.onClick();

        expect(edited).toEqual(message);
    });

    test('remove calls removeFromQueue', () => {
        const message = queued('q-remove', 'Drop this row');
        let removedId: string | undefined;
        const element = QueuedMessageRow({
            message,
            sendLabel: 'Steer',
            sendAria: 'Steer Conversation',
            emptyLabel: '(empty)',
            editAria: 'Edit Queued Message',
            removeAria: 'Remove from Queue',
            showSteerIcon: true,
            onEdit: () => undefined,
            onSend: () => undefined,
            onRemove: () => {
                removedId = message.id;
            },
        });
        const remove = collectButtons(element).find(
            (button) => button.props['aria-label'] === 'Remove from Queue',
        );
        if (!remove?.props.onClick) throw new Error('expected remove button');
        remove.props.onClick();

        expect(removedId).toBe(message.id);
    });

    test('the connected tab forwards Steer, Edit and Remove to the queue store and caller', async () => {
        const { act } = await import('react');
        const { withDom } = await import('@/test/mountedDom');
        const { createRoot } = await import('react-dom/client');
        const message = queued('q-connected', 'Connected queued prompt');
        const sentMessages: QueuedMessage[] = [];
        const edited: string[] = [];
        useSessionUIStore.setState({ currentSessionId: 'ses_queue' });
        useMessageQueueStore.setState({ queuedMessages: { ses_queue: [message] } });
        mockedPhase = 'busy';
        await withDom(async (container) => {
            const root = createRoot(container as unknown as Element);
            try {
                await act(async () => root.render(
                    <I18nProvider>
                        <QueuedMessageTab
                            tabBackground="#222222"
                            onEditMessage={(content) => { edited.push(content); }}
                            onSendMessage={(next) => { sentMessages.push(next); }}
                        />
                    </I18nProvider>,
                ));
                const byAria = (label: string) => container.find((node) => node.getAttribute('aria-label') === label);
                await act(async () => { byAria('Steer Conversation')!.click(); });
                expect(sentMessages).toEqual([message]);
                await act(async () => { byAria('Edit Queued Message')!.click(); });
                expect(edited).toEqual(['Connected queued prompt']);
                expect(useMessageQueueStore.getState().queuedMessages.ses_queue ?? []).toHaveLength(0);
                await act(async () => { useMessageQueueStore.setState({ queuedMessages: { ses_queue: [message] } }); });
                await act(async () => { byAria('Remove from Queue')!.click(); });
                expect(useMessageQueueStore.getState().queuedMessages.ses_queue ?? []).toHaveLength(0);
            } finally {
                await act(async () => root.unmount());
            }
        });
    });

    test('the connected tab renders nothing without a current session', () => {
        useSessionUIStore.setState({ currentSessionId: null });
        useMessageQueueStore.setState({ queuedMessages: { ses_queue: [queued('q1', 'Orphan')] } });
        expect(renderToStaticMarkup(
            <I18nProvider><QueuedMessageTab tabBackground="#222" onEditMessage={() => undefined} onSendMessage={() => undefined} /></I18nProvider>,
        )).toBe('');
    });

    test('renders null on an empty queue', () => {
        expect(renderTab([], 'busy')).toBe('');
    });

    test('labels Steer while abortable and Send Now when idle', () => {
        const queuedMessages = [queued('q1', 'Queued while a turn is running')];

        const busy = renderTab(queuedMessages, 'busy');
        expect(busy).toContain('Steer');
        expect(busy).not.toContain('Send Now');

        const idle = renderTab(queuedMessages, 'idle');
        expect(idle).toContain('Send Now');
        expect(idle).not.toContain('Steer');
    });
});
