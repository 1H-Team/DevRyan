import type { ToolPopupContent } from '../types';
import type { AssistantImageCandidate } from './generatedImageResults';

export interface ReadyAssistantImageTileState {
    status: 'ready';
    /** Blob object URL for fetched images, or the remote http(s) URL rendered directly by `<img>`. */
    url: string;
    mimeType?: string;
    size?: number;
    filename: string;
}

export const getAssistantImageGalleryClassName = (count: number): string => {
    if (count <= 1) return 'grid grid-cols-1 gap-3 w-full max-w-md';
    if (count === 2) return 'grid grid-cols-2 gap-3 w-full max-w-2xl';
    return 'grid grid-cols-2 sm:grid-cols-3 gap-3 w-full max-w-3xl';
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
        url: state.url,
        ...(state.mimeType ? { mimeType: state.mimeType } : {}),
        filename: state.filename,
        ...(typeof state.size === 'number' ? { size: state.size } : {}),
    },
});
