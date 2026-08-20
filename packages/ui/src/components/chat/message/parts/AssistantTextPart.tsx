import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2';
import { cn } from '@/lib/utils';
import { MarkdownRenderer } from '../../MarkdownRenderer';
import type { StreamPhase } from '../types';
import type { ContentChangeReason } from '@/hooks/useChatAutoFollow';
import { useStreamingTextThrottle } from '../../hooks/useStreamingTextThrottle';
import { resolveAssistantDisplayText, shouldRenderAssistantText } from './assistantTextVisibility';
import { postRendererTurnTimingMark, streamPerfCount, streamPerfObserve } from '@/stores/utils/streamDebug';
import type { ToolPopupContent } from '../types';
import GeneratedImageResult from './GeneratedImageResult';
import {
    splitGeneratedImageMarkdown,
    type GeneratedImageResult as GeneratedImageResultRecord,
} from './generatedImageResults';

type PartWithText = Part & { text?: string; content?: string; value?: string; time?: { start?: number; end?: number } };

const nowMs = (): number => {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
        return performance.now();
    }
    return Date.now();
};

interface AssistantTextPartProps {
    part: Part;
    sessionId?: string;
    messageId: string;
    streamPhase: StreamPhase;
    chatRenderMode?: 'sorted' | 'live';
    isPlanModeSource?: boolean;
    isMessageCompleted?: boolean;
    isMobile?: boolean;
    onContentChange?: (reason?: ContentChangeReason, messageId?: string) => void;
    generatedImages?: GeneratedImageResultRecord[];
    directory?: string;
    onShowPopup?: (content: ToolPopupContent) => void;
}

const AssistantTextPart: React.FC<AssistantTextPartProps> = ({
    part,
    sessionId,
    messageId,
    streamPhase,
    chatRenderMode = 'live',
    isMessageCompleted = false,
    isMobile = false,
    onContentChange,
    generatedImages = [],
    directory,
    onShowPopup,
}) => {
    // Use part directly from props — parent provides the latest version from the store.
    // No store subscription here to avoid re-render cascade from unrelated delta events.
    const partWithText = part as PartWithText;
    const rawText = typeof partWithText.text === 'string' ? partWithText.text : '';
    const contentText = typeof partWithText.content === 'string' ? partWithText.content : '';
    const valueText = typeof partWithText.value === 'string' ? partWithText.value : '';
    const textContent = [rawText, contentText, valueText].reduce((best, candidate) => {
        return candidate.length > best.length ? candidate : best;
    }, '');
    const isStreamingPhase = streamPhase === 'streaming';
    const isCooldownPhase = streamPhase === 'cooldown';
    const isStreaming = chatRenderMode === 'live' && (isStreamingPhase || isCooldownPhase);

    streamPerfCount('ui.assistant_text_part.render');
    if (isStreaming) {
        streamPerfCount('ui.assistant_text_part.render.streaming');
    }
    const renderStartedAt = nowMs();

    React.useEffect(() => {
        streamPerfObserve(
            isStreaming ? 'ui.assistant_text_part.commit_ms.streaming' : 'ui.assistant_text_part.commit_ms',
            nowMs() - renderStartedAt,
        );
    });

    const throttledTextContent = useStreamingTextThrottle({
        text: textContent,
        phase: isStreaming ? 'streaming' : 'terminal',
        identityKey: `${messageId}:${part.id ?? 'text'}`,
    });

    const displayTextContent = resolveAssistantDisplayText({
        textContent,
        throttledTextContent,
        isStreaming,
    });

    streamPerfObserve('ui.assistant_text_part.display_len', displayTextContent.length);

    const time = partWithText.time;
    const isFinalized = isMessageCompleted || Boolean(time && typeof time.end !== 'undefined');

    const isRenderableTextPart = part.type === 'text' || part.type === 'reasoning';
    const shouldRenderText = isRenderableTextPart && shouldRenderAssistantText({
        displayTextContent,
        isFinalized,
    });

    React.useEffect(() => {
        if (!shouldRenderText || !sessionId || displayTextContent.trim().length === 0) {
            return;
        }

        const postMark = () => {
            postRendererTurnTimingMark({
                sessionId,
                assistantMessageId: messageId,
                mark: 'renderer_first_visible_text_committed',
                metadata: { source: 'AssistantTextPart' },
            });
        };

        if (typeof requestAnimationFrame === 'function') {
            const frame = requestAnimationFrame(postMark);
            return () => cancelAnimationFrame(frame);
        }

        postMark();
    }, [displayTextContent, messageId, sessionId, shouldRenderText]);

    if (!shouldRenderText) {
        return null;
    }

    const segments = splitGeneratedImageMarkdown(displayTextContent, messageId, generatedImages);

    return (
        <div
            className={cn('group/assistant-text relative break-words', isMobile ? 'py-1' : 'py-1.5')}
            key={part.id || `${messageId}-text`}
        >
            {segments.map((segment, index) => segment.type === 'image' ? (
                <GeneratedImageResult
                    key={`generated-image-${segment.result.toolPartId}`}
                    result={segment.result}
                    directory={directory}
                    onShowPopup={onShowPopup}
                    onContentChange={(reason) => onContentChange?.(reason, messageId)}
                />
            ) : (
                <MarkdownRenderer
                    key={`markdown-${index}`}
                    content={segment.content}
                    part={part}
                    messageId={`${messageId}-markdown-${index}`}
                    isAnimated={false}
                    isStreaming={isStreaming}
                    disableStreamAnimation={chatRenderMode === 'sorted'}
                    variant={part.type === 'reasoning' ? 'reasoning' : 'assistant'}
                    enableFileReferences={isFinalized}
                />
            ))}
        </div>
    );
};

export default React.memo(AssistantTextPart);
