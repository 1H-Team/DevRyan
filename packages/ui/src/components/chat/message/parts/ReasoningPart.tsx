import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';
import type { ContentChangeReason } from '@/hooks/useChatAutoFollow';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { MarkdownRenderer } from '../../MarkdownRenderer';
import { useStreamingTextThrottle } from '../../hooks/useStreamingTextThrottle';
import type { ResponseStyleLevel } from '@/lib/responseStyle';
import { formatReasoningText } from './reasoningSummaryDisplay';

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
    time?: { start?: number; end?: number };
    showDuration?: boolean;
    isStreaming?: boolean;
    actions?: React.ReactNode;
};

export const ReasoningTimelineBlock: React.FC<ReasoningTimelineBlockProps> = ({
    text,
    variant: _variant,
    onContentChange,
    blockId,
    time: _time,
    showDuration: _showDuration = true,
    isStreaming = false,
    actions,
}) => {
    void _variant;
    void _time;
    void _showDuration;

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
        <div className="my-1" data-reasoning-block-id={blockId} data-message-text-export-root="true">
            <div className="relative pr-2 pb-2 pt-1">
                <div data-message-text-export-source="true">
                    <MarkdownRenderer
                        content={text}
                        messageId={blockId}
                        isAnimated={false}
                        isStreaming={isStreaming}
                        variant="reasoning"
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
};

const ReasoningPart = React.memo(({
    part,
    onContentChange,
    messageId,
    providerID,
    responseStyleLevel = 'provider',
}: ReasoningPartProps) => {
    const { t } = useI18n();
    const chatRenderMode = useUIStore((state) => state.chatRenderMode);
    const partWithText = part as PartWithText;
    const rawText = partWithText.text || partWithText.content || '';
    const textContent = React.useMemo(
        () => formatReasoningText(rawText, providerID, responseStyleLevel),
        [providerID, rawText, responseStyleLevel],
    );
    const time = partWithText.time;
    const isActive = typeof time?.end !== 'number';
    const isStreaming = chatRenderMode === 'live' && isActive;
    const throttledText = useStreamingTextThrottle({
        text: textContent,
        isStreaming,
        identityKey: `${messageId}:${part.id ?? 'reasoning'}`,
    });

    // Show reasoning even if time.end isn't set yet (during streaming)
    // If no text has arrived yet, keep active reasoning visible so the user can see work in progress.
    if (!throttledText || throttledText.trim().length === 0) {
        if (isActive) {
            return (
                <div
                    className="my-1 typography-meta text-muted-foreground"
                    data-reasoning-block-id={part.id || `${messageId}-reasoning`}
                    role="status"
                    aria-live="polite"
                >
                    <div className="relative pr-2 pb-2 pt-1">
                        <span className="inline-flex animate-pulse motion-reduce:animate-none">
                            {t('chat.reasoning.thinking')}
                        </span>
                    </div>
                </div>
            );
        }
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
        />
    );
});

export default ReasoningPart;
