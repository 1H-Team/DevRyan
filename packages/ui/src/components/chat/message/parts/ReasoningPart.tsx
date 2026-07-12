import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';
import type { ContentChangeReason } from '@/hooks/useChatAutoFollow';
import { useUIStore } from '@/stores/useUIStore';
import { MarkdownRenderer } from '../../MarkdownRenderer';
import { useStreamingTextThrottle } from '../../hooks/useStreamingTextThrottle';

type PartWithText = Part & {
    text?: string;
    content?: string;
    time?: { start?: number; end?: number };
};

export type ReasoningVariant = 'thinking' | 'justification';

const cleanReasoningText = (text: string): string => {
    if (typeof text !== 'string' || text.trim().length === 0) {
        return '';
    }

    const cleaned = text
        .split('\n')
        .map((line: string) => line.replace(/^>\s?/, '').trimEnd())
        .filter((line: string) => line.trim().length > 0)
        .join('\n')
        .trim();

    return cleaned;
};

type ReasoningTimelineBlockProps = {
    text: string;
    variant: ReasoningVariant;
    onContentChange?: (reason?: ContentChangeReason) => void;
    blockId: string;
    time?: { start?: number; end?: number };
    showDuration?: boolean;
    isStreaming?: boolean;
    actions?: React.ReactNode;
    alwaysShowActions?: boolean;
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
    alwaysShowActions: _alwaysShowActions = false,
}) => {
    void _variant;
    void _time;
    void _showDuration;
    void _alwaysShowActions;

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
    alwaysShowActions?: boolean;
};

const ReasoningPart = React.memo(({
    part,
    onContentChange,
    messageId,
    alwaysShowActions = false,
}: ReasoningPartProps) => {
    const chatRenderMode = useUIStore((state) => state.chatRenderMode);
    const partWithText = part as PartWithText;
    const rawText = partWithText.text || partWithText.content || '';
    const textContent = React.useMemo(() => cleanReasoningText(rawText), [rawText]);
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
                        <span className="inline-flex animate-pulse motion-reduce:animate-none">Thinking…</span>
                    </div>
                </div>
            );
        }
        return null;
    }

    return (
        <ReasoningTimelineBlock
            text={throttledText}
            variant="thinking"
            onContentChange={onContentChange}
            blockId={part.id || `${messageId}-reasoning`}
            time={time}
            showDuration={chatRenderMode !== 'sorted'}
            isStreaming={isStreaming}
            alwaysShowActions={alwaysShowActions}
        />
    );
});

// eslint-disable-next-line react-refresh/only-export-components
export const formatReasoningText = (text: string): string => cleanReasoningText(text);

export default ReasoningPart;
