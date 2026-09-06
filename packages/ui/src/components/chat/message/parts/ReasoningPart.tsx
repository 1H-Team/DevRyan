import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';
import type { ContentChangeReason } from '@/hooks/useChatAutoFollow';
import { useUIStore } from '@/stores/useUIStore';
import { MarkdownRenderer } from '../../MarkdownRenderer';
import { useStreamingTextThrottle } from '../../hooks/useStreamingTextThrottle';
import type { ResponseStyleLevel } from '@/lib/responseStyle';
import { formatReasoningText } from './reasoningSummaryDisplay';
import { isReasoningPartActive } from '../reasoningGrouping';
import { isKnownClippedXaiReasoningPreview } from '../reasoningRenderPolicy';

type PartWithText = Part & {
    text?: string;
    content?: string;
    time?: { start?: number; end?: number };
};

export type ReasoningVariant = 'thinking' | 'justification';

type ReasoningTimelineBlockProps = {
    text: string;
    variant: ReasoningVariant;
    onContentChange?: (reason?: ContentChangeReason) => void;
    blockId: string;
    isStreaming?: boolean;
    isMobile?: boolean;
    actions?: React.ReactNode;
};

export const ReasoningTimelineBlock: React.FC<ReasoningTimelineBlockProps> = ({
    text,
    variant,
    onContentChange,
    blockId,
    isStreaming = false,
    isMobile = false,
    actions,
}) => {
    React.useEffect(() => {
        if (text.trim().length === 0) {
            return;
        }
        onContentChange?.('structural');
    }, [onContentChange, text]);

    if (!text || text.trim().length === 0) {
        return null;
    }

    return (
        <div
            data-reasoning-block-id={variant === 'thinking' ? blockId : undefined}
            data-assistant-update-block-id={variant === 'justification' ? blockId : undefined}
            data-message-text-export-root="true"
        >
            <div className={isMobile ? 'relative pr-2 py-1' : 'relative pr-2 py-1.5'}>
                <div data-message-text-export-source="true">
                    <MarkdownRenderer
                        content={text}
                        messageId={blockId}
                        isAnimated={false}
                        isStreaming={isStreaming}
                        variant={variant === 'thinking' ? 'reasoning' : 'assistant'}
                        loadingFallback={<div className="whitespace-pre-wrap break-words">{text}</div>}
                    />
                </div>
                {actions ? (
                    <div className="mt-2 mb-1 flex items-center justify-start gap-1.5" data-message-actions="true">
                        <div className="flex items-center gap-1.5" data-message-action-group="true">
                            {actions}
                        </div>
                    </div>
                ) : null}
            </div>
        </div>
    );
};

type ReasoningPartProps = {
    part: Part;
    onContentChange?: (reason?: ContentChangeReason) => void;
    messageId: string;
    providerID?: string | null;
    responseStyleLevel?: ResponseStyleLevel;
    isMessageCompleted?: boolean;
    isMobile?: boolean;
};

const ReasoningPart = React.memo(({
    part,
    onContentChange,
    messageId,
    providerID,
    responseStyleLevel = 'provider',
    isMessageCompleted = false,
    isMobile = false,
}: ReasoningPartProps) => {
    const chatRenderMode = useUIStore((state) => state.chatRenderMode);
    const partWithText = part as PartWithText;
    const rawText = partWithText.text || partWithText.content || '';
    const shouldHideClippedPreview = isKnownClippedXaiReasoningPreview(part, providerID);
    const textContent = React.useMemo(
        () => shouldHideClippedPreview
            ? ''
            : formatReasoningText(rawText, providerID, responseStyleLevel),
        [providerID, rawText, responseStyleLevel, shouldHideClippedPreview],
    );
    const isActive = isReasoningPartActive(part);
    const isStreaming = chatRenderMode === 'live' && !isMessageCompleted && isActive;
    const throttledText = useStreamingTextThrottle({
        text: textContent,
        phase: isStreaming ? 'streaming' : 'terminal',
        identityKey: `${messageId}:${part.id ?? 'reasoning'}`,
    });

    // The group owns the compact lifecycle label until displayable text arrives.
    if (!throttledText || throttledText.trim().length === 0) {
        return null;
    }

    const blockId = part.id || `${messageId}-reasoning`;

    return (
        <ReasoningTimelineBlock
            text={throttledText}
            variant="thinking"
            onContentChange={onContentChange}
            blockId={blockId}
            isStreaming={isStreaming}
            isMobile={isMobile}
        />
    );
});

export default ReasoningPart;
