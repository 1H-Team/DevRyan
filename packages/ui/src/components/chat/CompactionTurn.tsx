import React from 'react';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useI18n } from '@/lib/i18n';
import type { ChatMessageEntry, Turn } from './lib/turns/types';
import type { CompactionKind } from './lib/compactionDisplay';
import { useIsPlanRevisionSuppressedTurn } from './usePlanTurnTraceEntry';

interface CompactionTurnProps {
    turn: Turn;
    kind: CompactionKind;
    renderAssistant: (message: ChatMessageEntry) => React.ReactNode;
}

const isCompleted = (message: ChatMessageEntry): boolean => {
    const completed = (message.info as { time?: { completed?: unknown } }).time?.completed;
    return typeof completed === 'number' && completed > 0;
};

const hasError = (message: ChatMessageEntry): boolean => Boolean((message.info as { error?: unknown }).error);

/**
 * A native compaction boundary renders as a slim divider instead of a user
 * bubble and a full summary. The summary stays one click away once it has
 * completed; while it streams the status row carries the shimmer, and a failed
 * summary is always shown so the error stays visible. The collapsed panel is
 * unmounted, so no markdown renders until it is opened.
 */
export const CompactionTurn = React.memo(({ turn, kind, renderAssistant }: CompactionTurnProps) => {
    const { t } = useI18n();
    const isSuppressedPlanContinuationTurn = useIsPlanRevisionSuppressedTurn(turn.turnId);
    const [open, setOpen] = React.useState(false);
    const summaries = turn.assistantMessages;
    const failed = summaries.filter(hasError);
    const completed = summaries.length > 0 && summaries.every(isCompleted) && failed.length === 0;

    if (isSuppressedPlanContinuationTurn) {
        return null;
    }

    const label = completed || failed.length > 0
        ? t(kind === 'automatic' ? 'chat.compaction.divider.automatic' : 'chat.compaction.divider.manual')
        : t('chat.compaction.inProgress');

    return (
        <section
            className="relative w-full"
            id={`turn-${turn.turnId}`}
            data-turn-id={turn.turnId}
            data-user-message-id={turn.userMessage.info.id}
            data-scroll-spy-id={turn.turnId}
            data-compaction-boundary={kind}
        >
            <Collapsible open={open} onOpenChange={setOpen}>
                <div className="flex items-center gap-3 py-2 typography-meta text-muted-foreground">
                    <span aria-hidden="true" className="h-px flex-1 bg-border/60" />
                    <span className="shrink-0">{label}</span>
                    {completed ? (
                        <CollapsibleTrigger className="w-auto shrink-0 px-1.5 py-0.5 typography-meta text-muted-foreground">
                            {open ? t('chat.compaction.hideSummary') : t('chat.compaction.showSummary')}
                        </CollapsibleTrigger>
                    ) : null}
                    <span aria-hidden="true" className="h-px flex-1 bg-border/60" />
                </div>
                {completed ? (
                    <CollapsibleContent>
                        {summaries.map((message) => (
                            <React.Fragment key={message.info.id}>{renderAssistant(message)}</React.Fragment>
                        ))}
                    </CollapsibleContent>
                ) : null}
            </Collapsible>
            {failed.map((message) => (
                <React.Fragment key={message.info.id}>{renderAssistant(message)}</React.Fragment>
            ))}
        </section>
    );
});

CompactionTurn.displayName = 'CompactionTurn';
