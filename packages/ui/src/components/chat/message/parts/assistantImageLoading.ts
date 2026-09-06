import type { AssistantImageCandidate } from './generatedImageResults';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
]);

export interface ReadyAssistantImagePreparation {
    candidate: AssistantImageCandidate;
    status: 'ready';
    url: string;
    filename: string;
    mimeType?: string;
    size?: number;
}

export interface FailedAssistantImagePreparation {
    candidate: AssistantImageCandidate;
    status: 'error';
    errorCode: string;
}

export type AssistantImagePreparation = ReadyAssistantImagePreparation | FailedAssistantImagePreparation;

export interface LoadedAssistantImage {
    objectUrl: string;
    mimeType: string;
    size: number;
}

export interface AssistantImageObjectUrlRegistry {
    track(url: string): string;
    revoke(url: string): void;
    revokeAll(): void;
}

export const createAssistantImageObjectUrlRegistry = (
    revokeObjectURL: (url: string) => void = (url) => URL.revokeObjectURL(url),
): AssistantImageObjectUrlRegistry => {
    const urls = new Set<string>();
    return {
        track(url) {
            urls.add(url);
            return url;
        },
        revoke(url) {
            if (!urls.delete(url)) return;
            revokeObjectURL(url);
        },
        revokeAll() {
            for (const url of urls) revokeObjectURL(url);
            urls.clear();
        },
    };
};

interface PrepareResponseResult {
    source: string;
    status: 'ready' | 'error';
    url?: string;
    filename?: string;
    mimeType?: string;
    size?: number;
    errorCode?: string;
}

const isRemoteSource = (source: string): boolean => /^https?:\/\//i.test(source);
const isEmbeddedSource = (source: string): boolean => /^data:image\/(?:png|jpeg|gif|webp)(?:;|,)/i.test(source);

export const isSafeAssistantImageExternalUrl = (source: string): boolean => {
    if (!isRemoteSource(source)) return false;
    try {
        const url = new URL(source);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
};

const failedPreparation = (
    candidate: AssistantImageCandidate,
    errorCode: string,
): FailedAssistantImagePreparation => ({ candidate, status: 'error', errorCode });

const parsePrepareResults = (payload: unknown): PrepareResponseResult[] => {
    if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { results?: unknown }).results)) {
        return [];
    }
    const parsed: PrepareResponseResult[] = [];
    for (const item of (payload as { results: unknown[] }).results) {
        if (!item || typeof item !== 'object') continue;
        const record = item as Record<string, unknown>;
        if (typeof record.source !== 'string' || (record.status !== 'ready' && record.status !== 'error')) continue;
        parsed.push({
            source: record.source,
            status: record.status,
            ...(typeof record.url === 'string' ? { url: record.url } : {}),
            ...(typeof record.filename === 'string' ? { filename: record.filename } : {}),
            ...(typeof record.mimeType === 'string' ? { mimeType: record.mimeType } : {}),
            ...(typeof record.size === 'number' && Number.isFinite(record.size) ? { size: record.size } : {}),
            ...(typeof record.errorCode === 'string' ? { errorCode: record.errorCode } : {}),
        });
    }
    return parsed;
};

export const prepareAssistantImageCandidates = async ({
    candidates,
    sessionId,

    signal,
    fetchImpl = fetch,
}: {
    candidates: readonly AssistantImageCandidate[];
    sessionId?: string;
    directory?: string;

    signal: AbortSignal;
    fetchImpl?: typeof fetch;
}): Promise<AssistantImagePreparation[]> => {
    const resolved = new Map<string, AssistantImagePreparation>();
    const localByMessage = new Map<string, AssistantImageCandidate[]>();

    for (const candidate of candidates) {
        if (isRemoteSource(candidate.source) || isEmbeddedSource(candidate.source)) {
            resolved.set(candidate.id, {
                candidate,
                status: 'ready',
                url: candidate.source,
                filename: candidate.filename,
                ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
                ...(typeof candidate.size === 'number' ? { size: candidate.size } : {}),
            });
            continue;
        }

        const messageCandidates = localByMessage.get(candidate.messageId);
        if (messageCandidates) messageCandidates.push(candidate);
        else localByMessage.set(candidate.messageId, [candidate]);
    }

    if (localByMessage.size > 0 && !sessionId?.trim()) {
        for (const candidatesForMessage of localByMessage.values()) {
            for (const candidate of candidatesForMessage) {
                resolved.set(candidate.id, failedPreparation(candidate, 'SESSION_UNAVAILABLE'));
            }
        }
    } else {
        await Promise.all([...localByMessage.entries()].map(async ([messageId, candidatesForMessage]) => {
            try {
                const response = await fetchImpl(
                    `/api/devryan/sessions/${encodeURIComponent(sessionId as string)}/image-assets/prepare`,
                    {
                        method: 'POST',
                        credentials: 'same-origin',
                        headers: {
                            Accept: 'application/json',
                            'Content-Type': 'application/json',
                            'X-DevRyan-CSRF': '1',
                        },
                        body: JSON.stringify({
                            messageId,
                            sources: candidatesForMessage.map((candidate) => candidate.source),
                        }),
                        signal,
                    },
                );
                if (!response.ok) throw new Error(`Image preparation failed with status ${response.status}`);
                const bySource = new Map(parsePrepareResults(await response.json()).map((item) => [item.source, item]));
                for (const candidate of candidatesForMessage) {
                    const result = bySource.get(candidate.source);
                    if (!result || result.status !== 'ready' || !result.url || !result.filename) {
                        resolved.set(candidate.id, failedPreparation(candidate, result?.errorCode || 'PREPARE_FAILED'));
                        continue;
                    }
                    resolved.set(candidate.id, {
                        candidate,
                        status: 'ready',
                        url: result.url,
                        filename: result.filename,
                        ...(result.mimeType ? { mimeType: result.mimeType } : {}),
                        ...(typeof result.size === 'number' ? { size: result.size } : {}),
                    });
                }
            } catch (error) {
                if (signal.aborted) throw error;
                for (const candidate of candidatesForMessage) {
                    resolved.set(candidate.id, failedPreparation(candidate, 'PREPARE_REQUEST_FAILED'));
                }
            }
        }));
    }

    return candidates.map((candidate) => resolved.get(candidate.id) ?? failedPreparation(candidate, 'PREPARE_FAILED'));
};

export const loadAssistantImageBlob = async ({
    url,
    signal,
    fetchImpl = fetch,
    createObjectURL = (blob: Blob) => URL.createObjectURL(blob),
}: {
    url: string;
    signal: AbortSignal;
    fetchImpl?: typeof fetch;
    createObjectURL?: (blob: Blob) => string;
}): Promise<LoadedAssistantImage> => {
    const response = await fetchImpl(url, {
        cache: 'no-store',
        credentials: 'same-origin',
        referrerPolicy: 'no-referrer',
        signal,
    });
    const mimeType = (response.headers.get('content-type') || '').split(';', 1)[0]?.trim().toLowerCase() || '';
    const announcedSize = Number(response.headers.get('content-length'));
    if (!response.ok) throw new Error(`Image preview failed with status ${response.status}`);
    if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) throw new Error('Image preview returned an unsupported MIME type');
    if (Number.isFinite(announcedSize) && announcedSize > MAX_IMAGE_BYTES) throw new Error('Image preview is too large');
    const blob = await response.blob();
    if (signal.aborted) throw new DOMException('Image load aborted', 'AbortError');
    if (blob.size > MAX_IMAGE_BYTES) throw new Error('Image preview is too large');
    return {
        objectUrl: createObjectURL(blob),
        mimeType,
        size: blob.size,
    };
};

export const resolveAssistantImageEditorPath = (source: string, directory?: string): string => {
    const localSource = source.split(/[?#]/, 1)[0] || source;
    if (/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(localSource) || !directory?.trim()) return localSource;
    return `${directory.replace(/[\\/]+$/, '')}/${localSource.replace(/^[\\/]+/, '')}`;
};

export { MAX_IMAGE_BYTES, SUPPORTED_IMAGE_MIME_TYPES };
