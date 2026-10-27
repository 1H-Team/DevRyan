import type { ToolPart } from '@opencode-ai/sdk/v2';

/**
 * Image media an MCP (or native) tool returned inline. The server projects each
 * `file` content item into `state.attachments`; large data URIs arrive as an
 * empty `url` plus `devryanOmitted` and are fetched on demand through the
 * single-message route with `attachments=inline`
 * (`packages/web/server/lib/opencode/tool-attachment-summary.js`).
 *
 * Only PNG, JPEG, GIF and WebP render, and only when the decoded bytes carry
 * the matching signature. SVG, HTML and every other type never render.
 */
export const TOOL_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ToolImageMimeType = typeof TOOL_IMAGE_MIME_TYPES[number];

export const MAX_TOOL_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TOOL_IMAGE_THUMBNAILS = 6;
const OBJECT_URL_CACHE_LIMIT = 48;

const FILE_EXTENSIONS: Record<ToolImageMimeType, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
};

export interface ToolImageAttachment {
    id: string;
    sessionID: string;
    messageID: string;
    mime: ToolImageMimeType;
    filename: string;
    /** The inline data URI, or null when the server omitted it. */
    dataUrl: string | null;
    /** Decoded size the server reported for an omitted image. */
    omittedBytes?: number;
}

export interface ResolvedToolImage {
    url: string;
    mime: ToolImageMimeType;
    size: number;
}

const EMPTY: readonly ToolImageAttachment[] = Object.freeze([]);
const parsedByState = new WeakMap<object, readonly ToolImageAttachment[]>();

const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
);

export const toToolImageMimeType = (value: unknown): ToolImageMimeType | null => {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    return TOOL_IMAGE_MIME_TYPES.find((mime) => mime === normalized) ?? null;
};

const DATA_URL_HEADER = /^data:([^;,]+);base64,/i;

const dataUrlMime = (url: string): ToolImageMimeType | null => {
    const match = DATA_URL_HEADER.exec(url);
    return match ? toToolImageMimeType(match[1]) : null;
};

const parseAttachment = (value: unknown, index: number): ToolImageAttachment | null => {
    if (!isRecord(value) || value.type !== 'file') return null;
    const mime = toToolImageMimeType(value.mime);
    if (!mime || typeof value.id !== 'string' || typeof value.sessionID !== 'string' || typeof value.messageID !== 'string') return null;
    if (typeof value.url !== 'string') return null;
    const filename = typeof value.filename === 'string' && value.filename.trim()
        ? value.filename.trim()
        : `tool-image-${index + 1}.${FILE_EXTENSIONS[mime]}`;
    const base = { id: value.id, sessionID: value.sessionID, messageID: value.messageID, mime, filename };
    if (value.url === '') {
        const omitted = value.devryanOmitted;
        if (!isRecord(omitted)) return null;
        const bytes = omitted.bytes;
        return typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0
            ? { ...base, dataUrl: null, omittedBytes: bytes }
            : { ...base, dataUrl: null };
    }
    // Remote and file URLs never load from a tool row; inline data must agree with the declared type.
    if (dataUrlMime(value.url) !== mime) return null;
    return { ...base, dataUrl: value.url };
};

/**
 * The renderable image attachments of a tool part. The result is cached per
 * `state` object, so repeated renders of an unchanged part return the same
 * array and never re-parse.
 */
export const readToolImageAttachments = (part: ToolPart): readonly ToolImageAttachment[] => {
    const state: unknown = part.state;
    if (!isRecord(state)) return EMPTY;
    const cached = parsedByState.get(state);
    if (cached) return cached;
    const raw = state.attachments;
    let parsed: readonly ToolImageAttachment[] = EMPTY;
    if (Array.isArray(raw) && raw.length > 0) {
        const attachments = raw.flatMap((value, index) => {
            const attachment = parseAttachment(value, index);
            return attachment ? [attachment] : [];
        });
        if (attachments.length > 0) parsed = Object.freeze(attachments);
    }
    parsedByState.set(state, parsed);
    return parsed;
};

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0): boolean => (
    bytes.length >= offset + signature.length && signature.every((byte, index) => bytes[offset + index] === byte)
);

/** The image type the bytes' signature proves, or null for anything else (SVG and HTML included). */
export const sniffToolImageMime = (bytes: Uint8Array): ToolImageMimeType | null => {
    if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
    if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
    if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
    return null;
};

/**
 * Decodes an allowlisted base64 image data URI into bytes. Returns null when
 * the header, the size cap, the base64 or the byte signature disagree.
 */
export const decodeToolImageDataUrl = (
    dataUrl: string,
    expectedMime: ToolImageMimeType,
): { bytes: Uint8Array<ArrayBuffer>; mime: ToolImageMimeType } | null => {
    const match = DATA_URL_HEADER.exec(dataUrl);
    if (!match || toToolImageMimeType(match[1]) !== expectedMime) return null;
    const payload = dataUrl.slice(match[0].length);
    if (Math.floor(payload.length * 3 / 4) > MAX_TOOL_IMAGE_BYTES + 2) return null;
    let binary: string;
    try {
        binary = atob(payload);
    } catch {
        return null;
    }
    if (binary.length > MAX_TOOL_IMAGE_BYTES) return null;
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return sniffToolImageMime(bytes) === expectedMime ? { bytes, mime: expectedMime } : null;
};

export interface ToolImageObjectUrlCache {
    get(id: string): ResolvedToolImage | undefined;
    put(id: string, bytes: Uint8Array<ArrayBuffer>, mime: ToolImageMimeType): ResolvedToolImage;
    clear(): void;
}

/**
 * Bounded LRU of decoded object URLs keyed by attachment id, so scrolling a
 * virtualized transcript back to a row reuses the decoded image. Evicted URLs
 * are revoked.
 */
export const createToolImageObjectUrlCache = ({
    limit = OBJECT_URL_CACHE_LIMIT,
    createObjectURL = (blob: Blob) => URL.createObjectURL(blob),
    revokeObjectURL = (url: string) => URL.revokeObjectURL(url),
}: {
    limit?: number;
    createObjectURL?: (blob: Blob) => string;
    revokeObjectURL?: (url: string) => void;
} = {}): ToolImageObjectUrlCache => {
    const entries = new Map<string, ResolvedToolImage>();
    return {
        get(id) {
            const entry = entries.get(id);
            if (!entry) return undefined;
            entries.delete(id);
            entries.set(id, entry);
            return entry;
        },
        put(id, bytes, mime) {
            const existing = entries.get(id);
            if (existing) return existing;
            const entry = { url: createObjectURL(new Blob([bytes], { type: mime })), mime, size: bytes.byteLength };
            entries.set(id, entry);
            while (entries.size > limit) {
                const oldest = entries.keys().next().value;
                if (oldest === undefined) break;
                const evicted = entries.get(oldest);
                entries.delete(oldest);
                if (evicted) revokeObjectURL(evicted.url);
            }
            return entry;
        },
        clear() {
            for (const entry of entries.values()) revokeObjectURL(entry.url);
            entries.clear();
        },
    };
};

/** Image data URIs of every tool attachment in a v1 message record, keyed by attachment id. */
export const collectToolImageDataUrls = (record: unknown): Map<string, string> => {
    const urls = new Map<string, string>();
    if (!isRecord(record) || !Array.isArray(record.parts)) return urls;
    for (const part of record.parts) {
        if (!isRecord(part) || part.type !== 'tool' || !isRecord(part.state) || !Array.isArray(part.state.attachments)) continue;
        for (const attachment of part.state.attachments) {
            if (!isRecord(attachment) || typeof attachment.id !== 'string' || typeof attachment.url !== 'string') continue;
            if (dataUrlMime(attachment.url) && toToolImageMimeType(attachment.mime) === dataUrlMime(attachment.url)) {
                urls.set(attachment.id, attachment.url);
            }
        }
    }
    return urls;
};

export interface ToolImageResolverDeps {
    baseUrl: string;
    directory?: string;
    fetchImpl?: typeof fetch;
    cache?: ToolImageObjectUrlCache;
}

let defaultCache: ToolImageObjectUrlCache | null = null;
const getDefaultCache = (): ToolImageObjectUrlCache => {
    defaultCache ??= createToolImageObjectUrlCache();
    return defaultCache;
};

const inflightMessages = new Map<string, Promise<Map<string, string>>>();

const fetchInlineMessage = (
    attachment: ToolImageAttachment,
    { baseUrl, directory, fetchImpl = globalThis.fetch }: ToolImageResolverDeps,
): Promise<Map<string, string>> => {
    const key = `${directory ?? ''}\0${attachment.sessionID}\0${attachment.messageID}`;
    const existing = inflightMessages.get(key);
    if (existing) return existing;
    const base = baseUrl.replace(/\/+$/, '');
    const url = new URL(
        `${base}/session/${encodeURIComponent(attachment.sessionID)}/message/${encodeURIComponent(attachment.messageID)}`,
        globalThis.location?.href ?? 'http://localhost',
    );
    url.searchParams.set('attachments', 'inline');
    if (directory) url.searchParams.set('directory', directory);
    // Shared by every thumbnail of the message, so no single caller's abort cancels it.
    const request = fetchImpl(url.toString(), { method: 'GET', headers: { accept: 'application/json' } })
        .then(async (response) => {
            if (!response.ok) throw new Error(`Tool image request failed with status ${response.status}`);
            return collectToolImageDataUrls(await response.json());
        })
        .finally(() => {
            inflightMessages.delete(key);
        });
    inflightMessages.set(key, request);
    return request;
};

/** A cached image, without any work. */
export const peekToolImage = (attachment: ToolImageAttachment, cache: ToolImageObjectUrlCache = getDefaultCache()) => (
    cache.get(attachment.id)
);

/**
 * Decodes an attachment into a cached object URL, fetching the full message
 * first when the server omitted the data. Returns null when the image cannot
 * be shown.
 */
export const resolveToolImage = async (
    attachment: ToolImageAttachment,
    deps: ToolImageResolverDeps,
): Promise<ResolvedToolImage | null> => {
    const cache = deps.cache ?? getDefaultCache();
    const cached = cache.get(attachment.id);
    if (cached) return cached;
    const dataUrl = attachment.dataUrl ?? (await fetchInlineMessage(attachment, deps)).get(attachment.id);
    if (!dataUrl) return null;
    const decoded = decodeToolImageDataUrl(dataUrl, attachment.mime);
    return decoded ? cache.put(attachment.id, decoded.bytes, decoded.mime) : null;
};
