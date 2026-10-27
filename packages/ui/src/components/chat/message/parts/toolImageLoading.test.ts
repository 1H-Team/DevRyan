import { describe, expect, test } from 'bun:test';
import type { ToolPart } from '@opencode-ai/sdk/v2';

import {
    collectToolImageDataUrls,
    createToolImageObjectUrlCache,
    decodeToolImageDataUrl,
    MAX_TOOL_IMAGE_BYTES,
    readToolImageAttachments,
    resolveToolImage,
    sniffToolImageMime,
} from './toolImageLoading';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const GIF = new TextEncoder().encode('GIF89a\u0001\u0000');
const WEBP = new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ');
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');

const toDataUrl = (mime: string, bytes: Uint8Array) => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;

const attachment = (index: number, mime: string, url: string, extra: Record<string, unknown> = {}) => ({
    id: `prt_msg:call:attachment:${index}`, sessionID: 'ses_1', messageID: 'msg_1', type: 'file', mime, url, ...extra,
});

const toolPart = (attachments: unknown[]): ToolPart => ({
    id: 'prt_tool', sessionID: 'ses_1', messageID: 'msg_1', type: 'tool', callID: 'call', tool: 'playwright_browser_take_screenshot',
    state: { status: 'completed', input: {}, output: '', title: '', metadata: {}, time: { start: 1, end: 2 }, attachments },
} as unknown as ToolPart);

const fakeUrls = () => {
    const created: Blob[] = [];
    const revoked: string[] = [];
    const cache = createToolImageObjectUrlCache({
        limit: 2,
        createObjectURL: (blob) => { created.push(blob); return `blob:fake/${created.length}`; },
        revokeObjectURL: (url) => { revoked.push(url); },
    });
    return { cache, created, revoked };
};

describe('readToolImageAttachments', () => {
    test('keeps only allowlisted inline images whose data URI agrees with the declared type', () => {
        const part = toolPart([
            attachment(0, 'image/png', toDataUrl('image/png', PNG)),
            attachment(1, 'image/svg+xml', toDataUrl('image/svg+xml', SVG)),
            attachment(2, 'image/png', toDataUrl('image/svg+xml', SVG)),
            attachment(3, 'image/png', 'https://example.test/x.png'),
            attachment(4, 'image/png', 'file:///etc/passwd'),
            attachment(5, 'application/pdf', toDataUrl('application/pdf', PNG)),
            attachment(6, 'IMAGE/JPEG', toDataUrl('image/jpeg', JPEG), { filename: 'photo.jpg' }),
            attachment(7, 'image/webp', '', { devryanOmitted: { bytes: 900_000 } }),
            attachment(8, 'image/gif', ''),
            { type: 'text', text: 'not an attachment' },
        ]);
        const parsed = readToolImageAttachments(part);
        expect(parsed.map((item) => [item.id.slice(-1), item.mime, item.filename, item.dataUrl === null, item.omittedBytes])).toEqual([
            ['0', 'image/png', 'tool-image-1.png', false, undefined],
            ['6', 'image/jpeg', 'photo.jpg', false, undefined],
            ['7', 'image/webp', 'tool-image-8.webp', true, 900_000],
        ]);
    });

    test('returns the same array for the same state and a shared empty array otherwise', () => {
        const part = toolPart([attachment(0, 'image/png', toDataUrl('image/png', PNG))]);
        expect(readToolImageAttachments(part)).toBe(readToolImageAttachments({ ...part }));
        const empty = toolPart([]);
        expect(readToolImageAttachments(empty)).toBe(readToolImageAttachments(toolPart([attachment(0, 'image/svg+xml', '')])));
        expect(readToolImageAttachments(empty)).toHaveLength(0);
    });
});

describe('decodeToolImageDataUrl', () => {
    test('accepts only bytes whose signature matches the declared type', () => {
        expect(sniffToolImageMime(PNG)).toBe('image/png');
        expect(sniffToolImageMime(JPEG)).toBe('image/jpeg');
        expect(sniffToolImageMime(GIF)).toBe('image/gif');
        expect(sniffToolImageMime(WEBP)).toBe('image/webp');
        expect(sniffToolImageMime(SVG)).toBeNull();

        expect(decodeToolImageDataUrl(toDataUrl('image/png', PNG), 'image/png')?.bytes).toEqual(PNG);
        // SVG or HTML disguised under an image type never decodes.
        expect(decodeToolImageDataUrl(toDataUrl('image/png', SVG), 'image/png')).toBeNull();
        expect(decodeToolImageDataUrl(toDataUrl('image/png', JPEG), 'image/png')).toBeNull();
        expect(decodeToolImageDataUrl(toDataUrl('image/jpeg', JPEG), 'image/png')).toBeNull();
        expect(decodeToolImageDataUrl('data:image/png;base64,***', 'image/png')).toBeNull();
        expect(decodeToolImageDataUrl(`data:image/png,${'x'}`, 'image/png')).toBeNull();
    });

    test('refuses payloads over the byte cap before decoding', () => {
        const oversized = `data:image/png;base64,${'A'.repeat(Math.ceil((MAX_TOOL_IMAGE_BYTES + 16) * 4 / 3))}`;
        expect(decodeToolImageDataUrl(oversized, 'image/png')).toBeNull();
    });
});

describe('tool image object URL cache', () => {
    test('reuses decoded images and revokes the least recently used one', () => {
        const { cache, created, revoked } = fakeUrls();
        const first = cache.put('a', PNG, 'image/png');
        expect(cache.put('a', PNG, 'image/png')).toBe(first);
        expect(created[0]?.type).toBe('image/png');
        cache.put('b', PNG, 'image/png');
        cache.get('a');
        cache.put('c', PNG, 'image/png');
        expect(revoked).toEqual(['blob:fake/2']);
        expect(cache.get('b')).toBeUndefined();
        cache.clear();
        expect(revoked).toHaveLength(3);
    });
});

describe('resolveToolImage', () => {
    test('decodes inline images without any request', async () => {
        const { cache } = fakeUrls();
        const [inline] = readToolImageAttachments(toolPart([attachment(0, 'image/png', toDataUrl('image/png', PNG))]));
        let calls = 0;
        const fetchImpl = (async () => { calls += 1; return Response.json({}); }) as unknown as typeof fetch;
        const resolved = await resolveToolImage(inline!, { baseUrl: '/api', fetchImpl, cache });
        expect(resolved).toEqual({ url: 'blob:fake/1', mime: 'image/png', size: PNG.byteLength });
        expect(calls).toBe(0);
    });

    test('fetches an omitted message once with inline attachments and shares it between thumbnails', async () => {
        const { cache } = fakeUrls();
        const omitted = readToolImageAttachments(toolPart([
            attachment(0, 'image/png', '', { devryanOmitted: { bytes: 16 } }),
            attachment(1, 'image/gif', '', { devryanOmitted: { bytes: 8 } }),
            attachment(2, 'image/png', '', { devryanOmitted: { bytes: 8 } }),
        ]));
        const requested: string[] = [];
        const fetchImpl = (async (url: string) => {
            requested.push(url);
            return Response.json({
                info: { id: 'msg_1' },
                parts: [{
                    type: 'tool',
                    state: { attachments: [
                        attachment(0, 'image/png', toDataUrl('image/png', PNG)),
                        attachment(1, 'image/gif', toDataUrl('image/gif', GIF)),
                        // A disguised SVG in the full message still never renders.
                        attachment(2, 'image/png', toDataUrl('image/png', SVG)),
                    ] },
                }],
            });
        }) as unknown as typeof fetch;
        const results = await Promise.all(omitted.map((item) => resolveToolImage(item, {
            baseUrl: 'http://127.0.0.1:3000/api/', directory: '/work space', fetchImpl, cache,
        })));
        expect(requested).toHaveLength(1);
        const url = new URL(requested[0]!);
        expect(url.pathname).toBe('/api/session/ses_1/message/msg_1');
        expect(url.searchParams.get('attachments')).toBe('inline');
        expect(url.searchParams.get('directory')).toBe('/work space');
        expect(results.map((result) => result?.mime ?? null)).toEqual(['image/png', 'image/gif', null]);
    });

    test('reports a failed fetch to the caller', async () => {
        const { cache } = fakeUrls();
        const [omitted] = readToolImageAttachments(toolPart([attachment(0, 'image/png', '', { devryanOmitted: { bytes: 1 } })]));
        const fetchImpl = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
        await expect(resolveToolImage(omitted!, { baseUrl: '/api', directory: '/other', fetchImpl, cache })).rejects.toThrow('404');
    });
});

describe('collectToolImageDataUrls', () => {
    test('collects only image data URIs whose type agrees', () => {
        const urls = collectToolImageDataUrls({ parts: [
            { type: 'text', text: 'x' },
            { type: 'tool', state: { attachments: [
                attachment(0, 'image/png', toDataUrl('image/png', PNG)),
                attachment(1, 'image/jpeg', toDataUrl('image/png', PNG)),
                attachment(2, 'image/svg+xml', toDataUrl('image/svg+xml', SVG)),
            ] } },
        ] });
        expect([...urls.keys()]).toEqual(['prt_msg:call:attachment:0']);
        expect(collectToolImageDataUrls(null).size).toBe(0);
    });
});
