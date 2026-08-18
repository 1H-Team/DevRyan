import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';
import { RiArrowDownSLine } from '@remixicon/react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { ContentChangeReason } from '@/hooks/useChatAutoFollow';
import type { ResponseStyleLevel } from '@/lib/responseStyle';
import { hasDisplayableReasoningText } from '../reasoningGrouping';
import ReasoningPart from './ReasoningPart';

export interface ReasoningGroupEntry {
    part: Part;
    messageId: string;
}

interface ReasoningGroupProps {
    entries: ReasoningGroupEntry[];
    providerID?: string | null;
    responseStyleLevel?: ResponseStyleLevel;
    onContentChange?: (reason?: ContentChangeReason) => void;
    isMobile?: boolean;
}

const getEntryKey = (entry: ReasoningGroupEntry, index: number): string => {
    const partId = (entry.part as { id?: unknown }).id;
    return typeof partId === 'string' && partId.length > 0
        ? `${entry.messageId}:${partId}`
        : `${entry.messageId}:reasoning:${index}`;
};

const ReasoningGroupInner: React.FC<ReasoningGroupProps> = ({
    entries,
    providerID,
    responseStyleLevel,
    onContentChange,
    isMobile = false,
}) => {
    const [isExpanded, setIsExpanded] = React.useState(false);
    const shouldReduceMotion = useReducedMotion() === true;
    const disclosureId = React.useId();
    const displayableEntries = React.useMemo(
        () => entries.filter((entry) => hasDisplayableReasoningText(entry.part)),
        [entries],
    );

    if (displayableEntries.length === 0) {
        return null;
    }

    if (displayableEntries.length === 1) {
        const entry = displayableEntries[0];
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

    const latestIndex = displayableEntries.length - 1;
    const previousEntries = displayableEntries.slice(0, latestIndex);
    const latestEntry = displayableEntries[latestIndex];
    const latestKey = getEntryKey(latestEntry, latestIndex);
    const hiddenCount = previousEntries.length;

    return (
        <div data-reasoning-group="true" className="group/reasoning">
            <div
                id={disclosureId}
                className={`grid overflow-hidden transition-[grid-template-rows] ease-out ${
                    isExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
                } ${shouldReduceMotion ? 'duration-0' : 'duration-200'}`}
                aria-hidden={!isExpanded}
                inert={!isExpanded}
            >
                <div className="min-h-0 overflow-hidden">
                    {previousEntries.map((entry, index) => (
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
            </div>

            <div className="flex min-w-0 items-start">
                <div className="relative min-w-0 flex-1 overflow-hidden">
                    <AnimatePresence mode="popLayout" initial={false}>
                        <motion.div
                            key={latestKey}
                            initial={shouldReduceMotion ? false : { y: 8, opacity: 0 }}
                            animate={{ y: 0, opacity: 1 }}
                            exit={shouldReduceMotion ? { opacity: 0 } : { y: -8, opacity: 0 }}
                            transition={{ duration: shouldReduceMotion ? 0 : 0.2, ease: 'easeOut' }}
                        >
                            <ReasoningPart
                                part={latestEntry.part}
                                messageId={latestEntry.messageId}
                                providerID={providerID}
                                responseStyleLevel={responseStyleLevel}
                                onContentChange={onContentChange}
                                isMobile={isMobile}
                            />
                        </motion.div>
                    </AnimatePresence>
                </div>
                <button
                    type="button"
                    className={`mt-1.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 transition-[background-color,color,opacity] hover:bg-foreground/5 hover:text-muted-foreground focus-visible:opacity-100 ${
                        isMobile || isExpanded
                            ? 'opacity-100'
                            : 'opacity-0 group-hover/reasoning:text-muted-foreground group-hover/reasoning:opacity-100'
                    }`}
                    aria-controls={disclosureId}
                    aria-expanded={isExpanded}
                    aria-label={isExpanded
                        ? `Hide ${hiddenCount} earlier reasoning ${hiddenCount === 1 ? 'line' : 'lines'}`
                        : `Show ${hiddenCount} earlier reasoning ${hiddenCount === 1 ? 'line' : 'lines'}`}
                    onClick={() => setIsExpanded((expanded) => !expanded)}
                >
                    <RiArrowDownSLine
                        aria-hidden="true"
                        className={`h-3.5 w-3.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                    />
                </button>
            </div>
        </div>
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
    && previous.isMobile === next.isMobile
));

export default ReasoningGroup;
