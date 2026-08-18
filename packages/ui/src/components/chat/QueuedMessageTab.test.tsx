import React from 'react';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { fileURLToPath } from 'node:url';

import { I18nProvider } from '@/lib/i18n';
import type { QueuedMessage } from '@/stores/messageQueueStore';
import { QueuedMessageRow, QueuedMessageTabView } from './QueuedMessageTab';

const tabSource = readFileSync(
    fileURLToPath(new URL('./QueuedMessageTab.tsx', import.meta.url)),
    'utf8',
);

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
        expect(tabSource).toContain('onSend={onSendMessage}');
        expect(tabSource).toContain('onSend={onSend}');
        expect(tabSource).toContain('RiSteering2Line');
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
        expect(tabSource).toContain('RiPencilLine');
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
        expect(tabSource).toContain('onRemove={(messageId) => removeFromQueue(currentSessionId, messageId)}');
    });

    test('renders null on an empty queue', () => {
        expect(renderTab([], 'busy')).toBe('');
        expect(tabSource).toContain('if (queuedMessages.length === 0 || !currentSessionId)');
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
