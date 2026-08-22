import { describe, expect, test } from 'bun:test';
import type { Part, ToolPart } from '@opencode-ai/sdk/v2';

import { assistantImageSyntaxFixtures } from '../../../../../../shared-runtime/testing/assistant-image-fixtures.js';
import { extractAssistantImageCandidates } from './generatedImageResults';

const textPart = (id: string, text: string): Part => ({ id, type: 'text', text } as Part);
const toolPart = (
    id: string,
    output: string,
    { tool = 'gpt_imagegen', mimeType, status = 'completed' }: {
        tool?: string;
        mimeType?: string;
        status?: string;
    } = {},
): Part => ({
    id,
    type: 'tool',
    tool,
    state: {
        status,
        metadata: { out: output, ...(mimeType ? { mimeType } : {}) },
        time: status === 'running' ? { start: 1 } : { start: 1, end: 2 },
    },
} as unknown as ToolPart);

describe('assistant image candidate projection', () => {
    for (const fixture of assistantImageSyntaxFixtures) {
        test(`matches shared syntax fixture: ${fixture.name}`, () => {
            const candidates = extractAssistantImageCandidates({
                responseComplete: true,
                messages: [{ messageId: 'message-1', parts: [textPart('text-1', fixture.markdown)] }],
            });
            expect(candidates.map((candidate) => ({
                source: candidate.source,
                caption: candidate.caption,
                kind: candidate.sourceKind,
            }))).toEqual(fixture.expected);
        });
    }

    test('preserves text order, dedupes sources, and appends unlinked finalized tool output', () => {
        const candidates = extractAssistantImageCandidates({
            responseComplete: true,
            messages: [
                {
                    messageId: 'text-message',
                    parts: [textPart('text-1', '![First](first.png) and [again](first.png), then ![Second](second.webp).')],
                },
                {
                    messageId: 'tool-message',
                    parts: [
                        toolPart('tool-linked', 'first.png'),
                        toolPart('tool-unlinked', '/tmp/final.gif', { tool: 'write', mimeType: 'image/gif' }),
                        toolPart('tool-arbitrary', '/tmp/not-image.png', { tool: 'write' }),
                        toolPart('tool-running', '/tmp/running.png', { status: 'running' }),
                    ],
                },
            ],
        });

        expect(candidates.map((candidate) => candidate.source)).toEqual(['first.png', 'second.webp', '/tmp/final.gif']);
        expect({
            messageId: candidates[0]?.messageId,
            toolPartId: candidates[0]?.toolPartId,
            caption: candidates[0]?.caption,
        }).toEqual({ messageId: 'tool-message', toolPartId: 'tool-linked', caption: 'First' });
        expect({
            sourceKind: candidates[2]?.sourceKind,
            mimeType: candidates[2]?.mimeType,
        }).toEqual({ sourceKind: 'tool-output', mimeType: 'image/gif' });
    });

    test('suppresses streaming responses and caps completed responses at twelve', () => {
        const markdown = Array.from({ length: 15 }, (_, index) => `![Image ${index}](image-${index}.png)`).join('\n');
        const messages = [{ messageId: 'message-1', parts: [textPart('text-1', markdown)] }];
        expect(extractAssistantImageCandidates({ messages, responseComplete: false })).toEqual([]);
        expect(extractAssistantImageCandidates({ messages, responseComplete: true })).toHaveLength(12);
    });
});
