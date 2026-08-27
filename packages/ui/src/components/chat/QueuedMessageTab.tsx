import React, { memo } from 'react';
import { RiCloseLine, RiMessage2Line, RiPencilLine, RiSteering2Line } from '@remixicon/react';
import { useMessageQueueStore, type QueuedMessage } from '@/stores/messageQueueStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInputStore } from '@/sync/input-store';
import { getSessionComposerTargetKey } from '@/sync/composer-target';
import { useI18n } from '@/lib/i18n';
import { useCurrentSessionActivity } from '@/hooks/useSessionActivity';
import { isAbortableSessionPhase } from './submitInterrupt';

function queuedMessageFirstLine(content: string): string {
    const lines = content.split('\n');
    const first = lines[0] || '';
    const maxLength = 100;
    if (first.length > maxLength) {
        return first.substring(0, maxLength) + '...';
    }
    return first + (lines.length > 1 ? '...' : '');
}

export interface QueuedMessageRowProps {
    message: QueuedMessage;
    sendLabel: string;
    sendAria: string;
    emptyLabel: string;
    attachmentsLabel?: string;
    editAria: string;
    removeAria: string;
    showSteerIcon: boolean;
    onEdit: (message: QueuedMessage) => void;
    onSend: (message: QueuedMessage) => void;
    onRemove: () => void;
}

export function QueuedMessageRow({
    message,
    sendLabel,
    sendAria,
    emptyLabel,
    attachmentsLabel,
    editAria,
    removeAria,
    showSteerIcon,
    onEdit,
    onSend,
    onRemove,
}: QueuedMessageRowProps) {
    const firstLine = queuedMessageFirstLine(message.content);
    const attachmentCount = message.attachments?.length ?? 0;

    return (
        <div className="flex min-w-0 items-center justify-between gap-2 py-0.5">
            <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left typography-ui-label text-muted-foreground">
                <RiMessage2Line
                    className="h-3.5 w-3.5 flex-shrink-0"
                    aria-hidden="true"
                />
                <span className="truncate text-foreground">
                    {firstLine || emptyLabel}
                </span>
                {attachmentCount > 0 && attachmentsLabel ? (
                    <span className="flex-shrink-0">{attachmentsLabel}</span>
                ) : null}
            </div>
            <div className="flex flex-shrink-0 items-center gap-1">
                <button
                    type="button"
                    className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 typography-ui-label text-muted-foreground transition-colors hover:bg-[var(--interactive-hover)] hover:text-foreground"
                    aria-label={sendAria}
                    onClick={() => onSend(message)}
                >
                    {showSteerIcon ? (
                        <RiSteering2Line className="h-3.5 w-3.5" aria-hidden="true" />
                    ) : null}
                    {sendLabel}
                </button>
                <button
                    type="button"
                    onClick={() => onEdit(message)}
                    className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[var(--interactive-hover)] hover:text-foreground"
                    aria-label={editAria}
                    title={editAria}
                >
                    <RiPencilLine className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <button
                    type="button"
                    onClick={onRemove}
                    className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[var(--interactive-hover)]"
                    aria-label={removeAria}
                >
                    <RiCloseLine className="h-4 w-4 text-muted-foreground" />
                </button>
            </div>
        </div>
    );
}

export interface QueuedMessageTabViewProps {
    tabBackground: string;
    queuedMessages: QueuedMessage[];
    sessionPhase: string;
    onEdit: (message: QueuedMessage) => void;
    onSend: (message: QueuedMessage) => void;
    onRemove: (messageId: string) => void;
}

export function QueuedMessageTabView({
    tabBackground,
    queuedMessages,
    sessionPhase,
    onEdit,
    onSend,
    onRemove,
}: QueuedMessageTabViewProps) {
    const { t } = useI18n();

    if (queuedMessages.length === 0) {
        return null;
    }

    const abortable = isAbortableSessionPhase(sessionPhase);
    const sendLabel = abortable ? t('chat.queuedMessage.steer') : t('chat.queuedMessage.sendNow');
    const sendAria = abortable ? t('chat.queuedMessage.steerAria') : t('chat.queuedMessage.sendAria');

    return (
        <div
            className="relative -mb-3 mx-6 flex min-w-0 flex-col rounded-t-xl px-2 pt-1 pb-3"
            style={{ backgroundColor: tabBackground }}
        >
            <div className="max-h-[7.5rem] overflow-y-auto">
                {queuedMessages.map((message) => (
                    <QueuedMessageRow
                        key={message.id}
                        message={message}
                        sendLabel={sendLabel}
                        sendAria={sendAria}
                        emptyLabel={t('chat.queuedMessage.empty')}
                        attachmentsLabel={
                            (message.attachments?.length ?? 0) > 0
                                ? t('chat.queuedMessage.attachments', { count: message.attachments?.length ?? 0 })
                                : undefined
                        }
                        editAria={t('chat.queuedMessage.editAria')}
                        removeAria={t('chat.queuedMessage.removeAria')}
                        showSteerIcon={abortable}
                        onEdit={onEdit}
                        onSend={onSend}
                        onRemove={() => onRemove(message.id)}
                    />
                ))}
            </div>
        </div>
    );
}

interface QueuedMessageTabProps {
    tabBackground: string;
    onEditMessage: (content: string, attachments?: QueuedMessage['attachments']) => void;
    onSendMessage: (message: QueuedMessage) => void;
}

const EMPTY_QUEUE: QueuedMessage[] = [];

export const QueuedMessageTab = memo(({
    tabBackground,
    onEditMessage,
    onSendMessage,
}: QueuedMessageTabProps) => {
    const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
    const { phase: sessionPhase } = useCurrentSessionActivity();
    const queuedMessages = useMessageQueueStore(
        React.useCallback(
            (state) => {
                if (!currentSessionId) return EMPTY_QUEUE;
                return state.queuedMessages[currentSessionId] ?? EMPTY_QUEUE;
            },
            [currentSessionId],
        ),
    );
    const popToInput = useMessageQueueStore((state) => state.popToInput);
    const removeFromQueue = useMessageQueueStore((state) => state.removeFromQueue);

    const handleEdit = React.useCallback((message: QueuedMessage) => {
        if (!currentSessionId) return;

        const popped = popToInput(currentSessionId, message.id);
        if (popped) {
            if (popped.attachments && popped.attachments.length > 0) {
                useInputStore.getState().mergeAttachedFilesForTarget(
                    getSessionComposerTargetKey(currentSessionId),
                    popped.attachments,
                );
            }
            onEditMessage(popped.content, popped.attachments);
        }
    }, [currentSessionId, popToInput, onEditMessage]);

    if (queuedMessages.length === 0 || !currentSessionId) {
        return null;
    }

    return (
        <QueuedMessageTabView
            tabBackground={tabBackground}
            queuedMessages={queuedMessages}
            sessionPhase={sessionPhase}
            onEdit={handleEdit}
            onSend={onSendMessage}
            onRemove={(messageId) => removeFromQueue(currentSessionId, messageId)}
        />
    );
});

QueuedMessageTab.displayName = 'QueuedMessageTab';
