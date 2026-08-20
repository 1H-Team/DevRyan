type AssistantPartLike = {
    type?: unknown;
    text?: unknown;
    content?: unknown;
    value?: unknown;
};

const getTextContent = (part: AssistantPartLike): string => {
    if (typeof part.text === 'string') {
        return part.text;
    }
    if (typeof part.content === 'string') {
        return part.content;
    }
    if (typeof part.value === 'string') {
        return part.value;
    }
    return '';
};

const isEmptyAssistantTextPart = (part: AssistantPartLike): boolean => {
    return part.type === 'text' && getTextContent(part).trim().length === 0;
};

export const hasRenderableAssistantContent = (parts: AssistantPartLike[]): boolean => {
    return parts.some((part) => part.type !== 'compaction' && !isEmptyAssistantTextPart(part));
};

export const shouldHideAssistantAbortArtifact = ({
    isUser,
    abortKind,
    parts,
}: {
    isUser: boolean;
    abortKind?: 'manual' | 'steered' | 'unexpected';
    parts: AssistantPartLike[];
}): boolean => {
    return !isUser && abortKind === 'manual' && !hasRenderableAssistantContent(parts);
};

export const getAssistantMessageBottomPaddingClass = ({
    isUser,
    isFollowedByAssistant,
    isPlaceholderOnlyStreaming,
    isTranscriptTail,
}: {
    isUser: boolean;
    isFollowedByAssistant: boolean;
    isPlaceholderOnlyStreaming: boolean;
    isTranscriptTail: boolean;
}): 'pb-0' | 'pb-8' => {
    if (isUser || isFollowedByAssistant || isPlaceholderOnlyStreaming || isTranscriptTail) {
        return 'pb-0';
    }
    return 'pb-8';
};

export const getAssistantMessageTopPaddingClass = ({
    isUser,
    shouldShowHeader,
    stickyUserHeader,
    isMobile,
}: {
    isUser: boolean;
    shouldShowHeader: boolean;
    stickyUserHeader: boolean;
    isMobile: boolean;
}): 'pt-0' | 'pt-2' | 'pt-3' | 'pt-4' | 'pt-6' => {
    if (isUser) {
        return 'pt-0';
    }
    if (shouldShowHeader) {
        if (!stickyUserHeader) {
            return 'pt-0';
        }
        return isMobile ? 'pt-4' : 'pt-6';
    }
    return 'pt-0';
};
