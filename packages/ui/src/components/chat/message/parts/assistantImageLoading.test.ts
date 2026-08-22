import { describe, expect, test } from 'bun:test';

import type { AssistantImageCandidate } from './generatedImageResults';
import {
    createAssistantImageObjectUrlRegistry,
    loadAssistantImageBlob,
    prepareAssistantImageCandidates,
} from './assistantImageLoading';

const candidate = (
    id: string,
    source: string,
    messageId = 'message-1',
): AssistantImageCandidate => ({
    id,
    source,
    filename: source.split('/').pop() || 'image.png',
    caption: id,
    sourceKind: 'markdown-image',
    messageId,
});

describe('assistant image preparation', () => {
    test('bypasses remote/data sources and groups web preparation by authoritative message', async () => {
        const requests: Array<{ url: string; init?: RequestInit }> = [];
        const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            requests.push({ url, init });
            const body = JSON.parse(String(init?.body)) as { sources: string[] };
            return new Response(JSON.stringify({
                results: body.sources.map((source) => ({
                    source,
                    status: 'ready',
                    url: `/api/fs/raw?path=${encodeURIComponent(source)}`,
                    filename: source.split('/').pop(),
                    mimeType: 'image/png',
                    size: 8,
                })),
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }) as typeof fetch;
        const controller = new AbortController();
        const candidates = [
            candidate('local-a', 'images/a.png', 'message-a'),
            candidate('remote', 'https://images.example/remote.webp', 'message-a'),
            candidate('embedded', 'data:image/png;base64,iVBORw0KGgo=', 'message-a'),
            candidate('local-b', '/tmp/b.png', 'message-b'),
        ];

        const results = await prepareAssistantImageCandidates({
            candidates,
            sessionId: 'session/1',
            isVSCode: false,
            signal: controller.signal,
            fetchImpl,
        });

        expect(requests.map((request) => request.url)).toEqual([
            '/api/devryan/sessions/session%2F1/image-assets/prepare',
            '/api/devryan/sessions/session%2F1/image-assets/prepare',
        ]);
        expect(requests.map((request) => JSON.parse(String(request.init?.body)))).toEqual([
            { messageId: 'message-a', sources: ['images/a.png'] },
            { messageId: 'message-b', sources: ['/tmp/b.png'] },
        ]);
        expect(requests.every((request) => new Headers(request.init?.headers).get('X-DevRyan-CSRF') === '1')).toBe(true);
        expect(results.map((result) => result.status)).toEqual(['ready', 'ready', 'ready', 'ready']);
        expect(results[1]?.status === 'ready' ? results[1].url : null).toBe('https://images.example/remote.webp');
        expect(results[2]?.status === 'ready' ? results[2].url : null).toBe('data:image/png;base64,iVBORw0KGgo=');
    });

    test('uses only the workspace raw bridge in VS Code and never forwards an asset grant', async () => {
        let fetchCount = 0;
        const results = await prepareAssistantImageCandidates({
            candidates: [candidate('workspace', 'art/result.png')],
            sessionId: 'session-1',
            directory: '/workspace',
            isVSCode: true,
            signal: new AbortController().signal,
            fetchImpl: (async () => {
                fetchCount += 1;
                throw new Error('Preparation API must not be called in VS Code');
            }) as typeof fetch,
        });

        expect(fetchCount).toBe(0);
        expect(results[0]?.status).toBe('ready');
        const url = results[0]?.status === 'ready' ? results[0].url : '';
        expect(url).toContain('/api/fs/raw?');
        expect(url).toContain('directory=%2Fworkspace');
        expect(url).toContain('assistantImage=1');
        expect(url).not.toContain('assetGrant');
    });
});

describe('assistant image blob lifecycle', () => {
    test('passes the abort signal, disables referrers, and creates an object URL only after validation', async () => {
        const controller = new AbortController();
        let capturedInit: RequestInit | undefined;
        let createdBlob: Blob | undefined;
        const loaded = await loadAssistantImageBlob({
            url: 'https://images.example/image.png',
            signal: controller.signal,
            fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
                capturedInit = init;
                return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), {
                    status: 200,
                    headers: { 'Content-Type': 'image/png', 'Content-Length': '3' },
                });
            }) as typeof fetch,
            createObjectURL: (blob) => {
                createdBlob = blob;
                return 'blob:assistant-image';
            },
        });

        expect(capturedInit?.signal).toBe(controller.signal);
        expect(capturedInit?.referrerPolicy).toBe('no-referrer');
        expect(capturedInit?.cache).toBe('no-store');
        expect(createdBlob?.size).toBe(3);
        expect(loaded).toEqual({ objectUrl: 'blob:assistant-image', mimeType: 'image/png', size: 3 });
    });

    test('aborts without creating a URL and revokes every tracked URL exactly once on cleanup', async () => {
        const controller = new AbortController();
        controller.abort();
        let created = 0;
        let aborted = false;
        try {
            await loadAssistantImageBlob({
                url: '/api/fs/raw?path=image.png',
                signal: controller.signal,
                fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
                    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
                    return new Response();
                }) as typeof fetch,
                createObjectURL: () => {
                    created += 1;
                    return 'blob:unexpected';
                },
            });
        } catch (error) {
            aborted = error instanceof DOMException && error.name === 'AbortError';
        }
        expect(aborted).toBe(true);
        expect(created).toBe(0);

        const revoked: string[] = [];
        const registry = createAssistantImageObjectUrlRegistry((url) => revoked.push(url));
        registry.track('blob:first');
        registry.track('blob:second');
        registry.track('blob:first');
        registry.revoke('blob:first');
        registry.revokeAll();
        registry.revokeAll();
        expect(revoked).toEqual(['blob:first', 'blob:second']);
    });
});
