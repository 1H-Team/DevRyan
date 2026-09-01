import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';
import { RiArrowRightSLine } from '@remixicon/react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import type { ContentChangeReason } from '@/hooks/useChatAutoFollow';
import { useI18n } from '@/lib/i18n';
import type { ResponseStyleLevel } from '@/lib/responseStyle';
import {
    hasDisplayableReasoningText,
    isReasoningPartActive,
    resolveReasoningRunActiveState,
} from '../reasoningGrouping';
import ReasoningPart from './ReasoningPart';
import { isReasoningDisclosureToggleKey } from './reasoningDisclosureKeyboard';
import { registerActiveReasoningDisclosure } from './reasoningDisclosureStatus';
import { formatReasoningDuration, getReasoningDurationMilliseconds } from './reasoningDuration';

export interface ReasoningGroupEntry {
    part: Part;
    messageId: string;
}

interface ReasoningGroupProps {
    entries: ReasoningGroupEntry[];
    providerID?: string | null;
    responseStyleLevel?: ResponseStyleLevel;
    onContentChange?: (reason?: ContentChangeReason) => void;
    isMessageCompleted?: boolean;
    isTrailingLiveRun?: boolean;
    isMobile?: boolean;
}

const REASONING_DISCLOSURE_DURATION_THRESHOLD_MS = 15_000;

const shouldRenderReasoningDisclosure = (
    entries: readonly ReasoningGroupEntry[],
    isActive: boolean,
): boolean => {
    if (isActive || entries.length >= 2) {
        return true;
    }

    const durationMilliseconds = getReasoningDurationMilliseconds(entries);
    return durationMilliseconds !== null
        && durationMilliseconds >= REASONING_DISCLOSURE_DURATION_THRESHOLD_MS;
};

const getEntryKey = (entry: ReasoningGroupEntry, index: number): string => {
    const partId = (entry.part as { id?: unknown }).id;
    return typeof partId === 'string' && partId.length > 0
        ? `${entry.messageId}:${partId}`
        : `${entry.messageId}:reasoning:${index}`;
};

interface ReasoningDisclosureProps extends ReasoningGroupProps {
    entries: ReasoningGroupEntry[];
    isExpanded: boolean;
    onExpandedChange: (expanded: boolean) => void;
}

export const ReasoningDisclosure: React.FC<ReasoningDisclosureProps> = ({
    entries,
    providerID,
    responseStyleLevel,
    onContentChange,
    isMessageCompleted = false,
    isTrailingLiveRun = false,
    isMobile = false,
    isExpanded,
    onExpandedChange,
}) => {
    const { t } = useI18n();
    const isActive = resolveReasoningRunActiveState({
        isMessageCompleted,
        hasActivePart: entries.some((entry) => isReasoningPartActive(entry.part)),
        isTrailingLiveRun,
    });
    const sessionID = (entries[0]?.part as { sessionID?: unknown } | undefined)?.sessionID;

    React.useLayoutEffect(() => {
        if (!isActive || typeof sessionID !== 'string' || sessionID.length === 0) return;
        return registerActiveReasoningDisclosure(sessionID);
    }, [isActive, sessionID]);

    const durationMilliseconds = isActive ? null : getReasoningDurationMilliseconds(entries);
    const duration = durationMilliseconds === null
        ? null
        : formatReasoningDuration(durationMilliseconds);
    const headerText = isActive
        ? t('chat.reasoning.thinking')
        : duration
            ? t('chat.reasoning.thoughtFor', { duration })
            : t('chat.reasoning.thought');
    const actionLabel = t(isExpanded ? 'chat.reasoning.collapse' : 'chat.reasoning.expand');
    const handleExpandedChange = React.useCallback((open: boolean) => {
        onExpandedChange(open);
        onContentChange?.('structural');
    }, [onContentChange, onExpandedChange]);
    const handleTriggerKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
        if (!isReasoningDisclosureToggleKey(event.key)) return;
        event.preventDefault();
        handleExpandedChange(!isExpanded);
    }, [handleExpandedChange, isExpanded]);

    return (
        <Collapsible
            open={isExpanded}
            onOpenChange={handleExpandedChange}
            className="group/reasoning max-md:w-full"
            data-reasoning-group="true"
            data-reasoning-disclosure-active={isActive ? 'true' : 'false'}
        >
            <CollapsibleTrigger
                className={`max-w-full justify-start gap-1.5 px-0 typography-meta text-muted-foreground hover:bg-transparent hover:text-foreground ${
                    isMobile
                        ? 'min-h-11 w-full py-2'
                        : 'min-h-6 w-fit py-1 max-md:min-h-11 max-md:w-full max-md:py-2'
                }`}
                aria-label={`${actionLabel}: ${headerText}`}
                title={headerText}
                onKeyDown={handleTriggerKeyDown}
            >
                <RiArrowRightSLine
                    className={`h-3.5 w-3.5 shrink-0 transition-transform motion-reduce:transition-none ${isExpanded ? 'rotate-90' : ''}`}
                    aria-hidden="true"
                />
                <span className={`min-w-0 truncate ${isActive ? 'animate-pulse motion-reduce:animate-none' : ''}`}>
                    {headerText}
                </span>
            </CollapsibleTrigger>
            <CollapsibleContent
                className="pl-4 motion-reduce:animate-none"
                data-reasoning-disclosure-content="true"
            >
                {isExpanded ? (
                    <div className={isMobile ? 'space-y-2' : 'space-y-3'}>
                        {entries.map((entry, index) => (
                            <ReasoningPart
                                key={getEntryKey(entry, index)}
                                part={entry.part}
                                messageId={entry.messageId}
                                providerID={providerID}
                                responseStyleLevel={responseStyleLevel}
                                onContentChange={onContentChange}
                                isMobile={isMobile}
                            />
                        ))}
                    </div>
                ) : null}
            </CollapsibleContent>
        </Collapsible>
    );
};

const ReasoningGroupInner: React.FC<ReasoningGroupProps> = ({
    entries,
    providerID,
    responseStyleLevel,
    onContentChange,
    isMessageCompleted = false,
    isTrailingLiveRun = false,
    isMobile = false,
}) => {
    const [isExpanded, setIsExpanded] = React.useState(false);
    const isActive = resolveReasoningRunActiveState({
        isMessageCompleted,
        hasActivePart: entries.some((entry) => isReasoningPartActive(entry.part)),
        isTrailingLiveRun,
    });
    const displayableEntries = React.useMemo(
        () => entries.filter((entry, index) => (
            hasDisplayableReasoningText(entry.part, providerID)
            || (isActive && (
                isReasoningPartActive(entry.part)
                || index === entries.length - 1
            ))
        )),
        [entries, isActive, providerID],
    );

    if (displayableEntries.length === 0) {
        return null;
    }

    if (!shouldRenderReasoningDisclosure(displayableEntries, isActive)) {
        const entry = displayableEntries[0];
        if (!entry) return null;

        return (
            <ReasoningPart
                part={entry.part}
                messageId={entry.messageId}
                providerID={providerID}
                responseStyleLevel={responseStyleLevel}
                onContentChange={onContentChange}
                isMobile={isMobile}
            />
        );
    }

    return (
        <ReasoningDisclosure
            entries={displayableEntries}
            providerID={providerID}
            responseStyleLevel={responseStyleLevel}
            onContentChange={onContentChange}
            isMessageCompleted={isMessageCompleted}
            isTrailingLiveRun={isTrailingLiveRun}
            isMobile={isMobile}
            isExpanded={isExpanded}
            onExpandedChange={setIsExpanded}
        />
    );
};

const areEntriesEqual = (
    previous: ReasoningGroupEntry[],
    next: ReasoningGroupEntry[],
): boolean => previous.length === next.length && previous.every((entry, index) => (
    entry.part === next[index]?.part && entry.messageId === next[index]?.messageId
));

const ReasoningGroup = React.memo(ReasoningGroupInner, (previous, next) => (
    areEntriesEqual(previous.entries, next.entries)
    && previous.providerID === next.providerID
    && previous.responseStyleLevel === next.responseStyleLevel
    && previous.onContentChange === next.onContentChange
    && previous.isMessageCompleted === next.isMessageCompleted
    && previous.isTrailingLiveRun === next.isTrailingLiveRun
    && previous.isMobile === next.isMobile
));

export default ReasoningGroup;
