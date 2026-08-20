import { describe, expect, test } from 'bun:test';
import type { Part, ToolPart } from '@opencode-ai/sdk/v2';

import type { TurnActivityRecord } from '../../lib/turns/types';
import {
    annotateGeneratedImageLinks,
    buildGeneratedImageRawUrl,
    extractGeneratedImageResults,
    matchGeneratedImageStandaloneLink,
    normalizeGeneratedImageLinkTarget,
    splitGeneratedImageMarkdown,
} from './generatedImageResults';

const toolActivity = (
    id: string,
    outputPath: unknown,
    status = 'completed',
    tool = 'gpt_imagegen',
): TurnActivityRecord => ({
    id,
    turnId: 'turn-1',
    messageId: 'assistant-tool',
    partIndex: 0,
    kind: 'tool',
    part: {
        id,
        type: 'tool',
        tool,
        state: {
            status,
            input: {},
            output: `Generated image saved to ${String(outputPath)}.`,
            metadata: { out: outputPath },
            time: status === 'running' ? { start: 1 } : { start: 1, end: 2 },
        },
    } as unknown as ToolPart,
});

const textPart = (text: string): Part => ({
    id: 'text-1',
    type: 'text',
    text,
} as Part);

describe('generated image result projection', () => {
    test('extracts only finalized GPT image generation results', () => {
        const results = extractGeneratedImageResults([
            toolActivity('image-1', '/repo/generated/apple.png'),
            toolActivity('image-2', '/repo/generated/apple-v2.png'),
            toolActivity('running', '/repo/generated/running.png', 'running'),
            toolActivity('other', '/repo/generated/other.png', 'completed', 'write'),
            toolActivity('malformed', 42),
        ]);

        expect(results).toEqual([
            { toolPartId: 'image-1', path: '/repo/generated/apple.png', filename: 'apple.png' },
            { toolPartId: 'image-2', path: '/repo/generated/apple-v2.png', filename: 'apple-v2.png' },
        ]);
    });

    test('normalizes plain, encoded, file, and authorized raw-route targets', () => {
        expect(normalizeGeneratedImageLinkTarget('/repo/generated/apple%20red.png')).toBe('/repo/generated/apple red.png');
        expect(normalizeGeneratedImageLinkTarget('file:///repo/generated/apple%20red.png')).toBe('/repo/generated/apple red.png');
        expect(normalizeGeneratedImageLinkTarget('/api/fs/raw?path=%2Frepo%2Fgenerated%2Fapple.png')).toBe('/repo/generated/apple.png');
        expect(normalizeGeneratedImageLinkTarget('https://example.com/apple.png')).toBe('https://example.com/apple.png');
    });

    test('matches only standalone links targeting an exact generated path', () => {
        const result = { toolPartId: 'image-1', path: '/repo/apple.png', filename: 'apple.png' };
        expect(matchGeneratedImageStandaloneLink('[View apple](/repo/apple.png)', [result]))
            .toEqual({ result, label: 'View apple' });
        expect(matchGeneratedImageStandaloneLink('See [View apple](/repo/apple.png)', [result])).toBeNull();
        expect(matchGeneratedImageStandaloneLink('[Other](/repo/other.png)', [result])).toBeNull();
        expect(matchGeneratedImageStandaloneLink('![Already an image](/repo/apple.png)', [result])).toBeNull();
    });

    test('annotates the first matching assistant message and splits the link in place', () => {
        const [base] = extractGeneratedImageResults([toolActivity('image-1', '/repo/generated/apple.png')]);
        const [annotated] = annotateGeneratedImageLinks([base], [{
            messageId: 'assistant-final',
            parts: [textPart('Generated an apple:\n\n[View generated apple](file:///repo/generated/apple.png)\n\nPNG image.')],
        }]);

        expect(annotated.linkedMessageId).toBe('assistant-final');
        expect(annotated.linkLabel).toBe('View generated apple');
        expect(splitGeneratedImageMarkdown(
            'Generated an apple:\n\n[View generated apple](file:///repo/generated/apple.png)\n\nPNG image.',
            'assistant-final',
            [annotated],
        )).toEqual([
            { type: 'markdown', content: 'Generated an apple:\n' },
            { type: 'image', result: annotated },
            { type: 'markdown', content: '\nPNG image.' },
        ]);
    });

    test('leaves ordinary Markdown unchanged when no matching link exists', () => {
        const result = { toolPartId: 'image-1', path: '/repo/apple.png', filename: 'apple.png' };
        const content = 'Open [the source](/repo/source.ts) for details.';
        expect(splitGeneratedImageMarkdown(content, 'assistant-final', [result]))
            .toEqual([{ type: 'markdown', content }]);
    });

    test('builds the cross-runtime raw-file request with directory context', () => {
        expect(buildGeneratedImageRawUrl('/repo/generated/apple red.png', '/repo/worktree'))
            .toBe('/api/fs/raw?path=%2Frepo%2Fgenerated%2Fapple+red.png&directory=%2Frepo%2Fworktree');
    });
});
