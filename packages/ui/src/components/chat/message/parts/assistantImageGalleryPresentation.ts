import type { ToolPopupContent } from '../types';
import type { AssistantImageCandidate } from './generatedImageResults';

export interface ReadyAssistantImageTileState {
    status: 'ready';
    objectUrl: string;
    mimeType: string;
    size: number;
    filename: string;
}

export const getAssistantImageGalleryClassName = (count: number): string => {
    if (count <= 1) return 'grid grid-cols-1 gap-3 w-full max-w-2xl';
    if (count === 2) return 'grid grid-cols-2 gap-3 w-full max-w-4xl';
    return 'grid grid-cols-2 sm:grid-cols-3 gap-3 w-full';
};

export const formatExactAssistantImageSize = (bytes: number): string => (
    `${new Intl.NumberFormat().format(Math.max(0, Math.trunc(bytes)))} B`
);

export const buildAssistantImagePopup = (
    candidate: AssistantImageCandidate,
    state: ReadyAssistantImageTileState,
): ToolPopupContent => ({
    open: true,
    title: state.filename,
    content: '',
    metadata: {
        tool: 'assistant-image',
        source: candidate.source,
        sourceKind: candidate.sourceKind,
        ...(candidate.toolPartId ? { toolPartId: candidate.toolPartId } : {}),
    },
    image: {
        url: state.objectUrl,
        mimeType: state.mimeType,
        filename: state.filename,
        size: state.size,
    },
});
