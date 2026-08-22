import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';
import type { ContentChangeReason } from '@/hooks/useChatAutoFollow';
import { useUIStore } from '@/stores/useUIStore';
import { useStreamingTextThrottle } from '../../hooks/useStreamingTextThrottle';
import { ReasoningTimelineBlock } from './ReasoningPart';

type PartWithText = Part & { text?: string; content?: string };

const formatJustificationText = (text: string): string => {
    if (typeof text !== 'string' || text.trim().length === 0) {
        return '';
    }

    return text
        .trim()
        .replace(/^(\*\*[^\n]+?\*\*)(?=[\p{L}\p{N}])/u, '$1\n\n');
};

interface JustificationBlockProps {
    part: Part;
    messageId: string;
    isMessageCompleted?: boolean;
    isMobile?: boolean;
    onContentChange?: (reason?: ContentChangeReason) => void;
    actions?: React.ReactNode;
}

const JustificationBlock: React.FC<JustificationBlockProps> = ({
    part,
    messageId,
    isMessageCompleted = true,
    isMobile = false,
    onContentChange,
    actions,
}) => {
    const chatRenderMode = useUIStore((state) => state.chatRenderMode);
    const partWithText = part as PartWithText;
    const rawText = partWithText.text || partWithText.content || '';
    const textContent = React.useMemo(() => formatJustificationText(rawText), [rawText]);
    const isStreaming = chatRenderMode === 'live' && !isMessageCompleted;
    const throttledText = useStreamingTextThrottle({
        text: textContent,
        phase: isStreaming ? 'streaming' : 'terminal',
        identityKey: `${messageId}:${part.id ?? 'justification'}`,
    });

    // Don't render if there's no text content
    if (!throttledText || throttledText.trim().length === 0) {
        return null;
    }

    return (
        <ReasoningTimelineBlock
            text={throttledText}
            variant="justification"
            onContentChange={onContentChange}
            blockId={part.id || `${messageId}-justification`}
            isStreaming={isStreaming}
            isMobile={isMobile}
            actions={actions}
        />
    );
};

export default React.memo(JustificationBlock);
