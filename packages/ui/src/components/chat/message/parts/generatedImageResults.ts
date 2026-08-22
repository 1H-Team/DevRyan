import type { Part, ToolPart } from '@opencode-ai/sdk/v2';
import {
    canonicalizeAssistantImageSource,
    extractAssistantImageReferences,
    isSupportedAssistantImageSource,
    type AssistantImageReferenceKind,
} from '../../../../../../shared-runtime/lib/assistant-image-sources.js';

import { isToolPartFinalizedForDisplay } from './toolDisplayState';
import { normalizeToolName } from './toolRenderUtils';

export type AssistantImageSourceKind = AssistantImageReferenceKind | 'tool-output';

export interface AssistantImageCandidate {
    id: string;
    source: string;
    filename: string;
    caption: string;
    sourceKind: AssistantImageSourceKind;
    messageId: string;
    toolPartId?: string;
    preparedUrl?: string;
    mimeType?: string;
    size?: number;
}

export interface AssistantImageMessage {
    messageId: string;
    parts: readonly Part[];
}

const readTextPart = (part: Part): string => {
    const candidate = part as Part & { text?: unknown; content?: unknown; value?: unknown };
    return [candidate.text, candidate.content, candidate.value]
        .filter((value): value is string => typeof value === 'string')
        .reduce((longest, value) => value.length > longest.length ? value : longest, '');
};

const filenameForSource = (source: string): string => {
    if (source.startsWith('data:image/png')) return 'embedded-image.png';
    if (source.startsWith('data:image/jpeg')) return 'embedded-image.jpg';
    if (source.startsWith('data:image/gif')) return 'embedded-image.gif';
    if (source.startsWith('data:image/webp')) return 'embedded-image.webp';
    try {
        const url = new URL(source, 'https://devryan.invalid');
        const filename = decodeURIComponent(url.pathname).replace(/\\/g, '/').split('/').pop();
        if (filename) return filename;
    } catch {
        // Plain local paths are handled below.
    }
    return source.replace(/\\/g, '/').split(/[?#]/, 1)[0]?.split('/').pop() || 'image';
};

const stableCandidateId = (messageId: string, source: string): string => {
    let hash = 2_166_136_261;
    const value = `${messageId}\n${source}`;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16_777_619);
    }
    return `assistant-image-${(hash >>> 0).toString(16).padStart(8, '0')}`;
};

const readDeclaredMimeType = (metadata: Record<string, unknown>): string => {
    for (const key of ['mimeType', 'mime', 'contentType']) {
        const value = metadata[key];
        if (typeof value === 'string' && value.trim()) return value.trim().toLowerCase();
    }
    return '';
};

const isImageGenerationTool = (toolName: string): boolean => (
    toolName === 'gpt_imagegen'
    || toolName === 'imagegen'
    || toolName === 'image_gen'
    || toolName === 'image_generation'
);

const extractToolOutput = (part: ToolPart): { source: string; mimeType?: string } | null => {
    if (!isToolPartFinalizedForDisplay(part)) return null;
    const state = part.state as { metadata?: unknown } | undefined;
    const metadata = state?.metadata && typeof state.metadata === 'object' && !Array.isArray(state.metadata)
        ? state.metadata as Record<string, unknown>
        : {};
    const output = typeof metadata.out === 'string' ? metadata.out.trim() : '';
    const source = canonicalizeAssistantImageSource(output);
    if (!source || !isSupportedAssistantImageSource(source)) return null;
    const mimeType = readDeclaredMimeType(metadata);
    if (!mimeType.startsWith('image/') && !isImageGenerationTool(normalizeToolName(part.tool))) return null;
    return { source, ...(mimeType ? { mimeType } : {}) };
};

export const buildAssistantImageRawUrl = (
    path: string,
    directory?: string,
    assetGrant?: string,
    workspaceOnly = false,
): string => {
    const params = new URLSearchParams({ path });
    if (directory?.trim()) params.set('directory', directory.trim());
    if (assetGrant?.trim()) params.set('assetGrant', assetGrant.trim());
    if (workspaceOnly) params.set('assistantImage', '1');
    return `/api/fs/raw?${params.toString()}`;
};

export const extractAssistantImageCandidates = ({
    messages,
    responseComplete,
    limit = 12,
}: {
    messages: readonly AssistantImageMessage[];
    responseComplete: boolean;
    limit?: number;
}): AssistantImageCandidate[] => {
    if (!responseComplete || limit <= 0) return [];
    const candidates: AssistantImageCandidate[] = [];
    const indexBySource = new Map<string, number>();

    for (const message of messages) {
        for (const part of message.parts) {
            if (part.type !== 'text') continue;
            for (const reference of extractAssistantImageReferences(readTextPart(part))) {
                if (indexBySource.has(reference.source)) continue;
                indexBySource.set(reference.source, candidates.length);
                const filename = filenameForSource(reference.source);
                candidates.push({
                    id: stableCandidateId(message.messageId, reference.source),
                    source: reference.source,
                    filename,
                    caption: reference.caption || filename,
                    sourceKind: reference.kind,
                    messageId: message.messageId,
                });
            }
        }
    }

    const unlinkedToolCandidates: AssistantImageCandidate[] = [];
    for (const message of messages) {
        for (const part of message.parts) {
            if (part.type !== 'tool') continue;
            const output = extractToolOutput(part as ToolPart);
            if (!output) continue;
            const existingIndex = indexBySource.get(output.source);
            if (typeof existingIndex === 'number') {
                if (existingIndex < candidates.length) {
                    const existing = candidates[existingIndex];
                    candidates[existingIndex] = {
                        ...existing,
                        messageId: message.messageId,
                        toolPartId: part.id,
                        ...(output.mimeType ? { mimeType: output.mimeType } : {}),
                    };
                }
                continue;
            }
            indexBySource.set(output.source, candidates.length + unlinkedToolCandidates.length);
            const filename = filenameForSource(output.source);
            unlinkedToolCandidates.push({
                id: stableCandidateId(message.messageId, output.source),
                source: output.source,
                filename,
                caption: filename,
                sourceKind: 'tool-output',
                messageId: message.messageId,
                toolPartId: part.id,
                ...(output.mimeType ? { mimeType: output.mimeType } : {}),
            });
        }
    }

    return [...candidates, ...unlinkedToolCandidates].slice(0, Math.min(12, Math.floor(limit)));
};
