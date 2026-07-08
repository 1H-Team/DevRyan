import { describe, expect, test } from 'bun:test';
import {
    getAssistantMessageBottomPaddingClass,
    hasRenderableAssistantContent,
    shouldHideAssistantAbortArtifact,
} from './chatMessageLayout';

describe('getAssistantMessageBottomPaddingClass', () => {
    test('removes bottom padding only for streaming assistant placeholders with a header and no content', () => {
        expect(getAssistantMessageBottomPaddingClass({
            isUser: false,
            isFollowedByAssistant: false,
            isPlaceholderOnlyStreaming: true,
        })).toBe('pb-0');

        expect(getAssistantMessageBottomPaddingClass({
            isUser: false,
            isFollowedByAssistant: false,
            isPlaceholderOnlyStreaming: false,
        })).toBe('pb-8');

        expect(getAssistantMessageBottomPaddingClass({
            isUser: true,
            isFollowedByAssistant: false,
            isPlaceholderOnlyStreaming: true,
        })).toBe('pb-0');
    });
});

describe('hasRenderableAssistantContent', () => {
    test('treats empty text and compaction parts as placeholder content', () => {
        expect(hasRenderableAssistantContent([
            { type: 'text', text: '   ' },
            { type: 'compaction' },
        ])).toBe(false);

        expect(hasRenderableAssistantContent([
            { type: 'text', text: 'Assistant output' },
        ])).toBe(true);

        expect(hasRenderableAssistantContent([
            { type: 'reasoning' },
        ])).toBe(true);
    });
});

describe('shouldHideAssistantAbortArtifact', () => {
    test('hides assistant messages that only represent an empty manual abort', () => {
        expect(shouldHideAssistantAbortArtifact({
            isUser: false,
            abortKind: 'manual',
            parts: [
                { type: 'text', text: '   ' },
                { type: 'compaction' },
            ],
        })).toBe(true);
    });

    test('keeps manual abort messages that include real assistant content', () => {
        expect(shouldHideAssistantAbortArtifact({
            isUser: false,
            abortKind: 'manual',
            parts: [
                { type: 'text', text: 'Partial answer before stop' },
            ],
        })).toBe(false);

        expect(shouldHideAssistantAbortArtifact({
            isUser: false,
            abortKind: 'manual',
            parts: [
                { type: 'tool' },
            ],
        })).toBe(false);
    });

    test('does not hide unexpected abort messages', () => {
        expect(shouldHideAssistantAbortArtifact({
            isUser: false,
            abortKind: 'unexpected',
            parts: [],
        })).toBe(false);
    });

    test('does not hide steered abort markers without assistant content', () => {
        expect(shouldHideAssistantAbortArtifact({
            isUser: false,
            abortKind: 'steered',
            parts: [],
        })).toBe(false);
    });
});
