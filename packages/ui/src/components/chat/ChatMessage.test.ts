import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import {
    getAssistantMessageBottomPaddingClass,
    getAssistantMessageTopPaddingClass,
    hasRenderableAssistantContent,
    resolveShouldShowAssistantHeader,
    shouldHideAssistantAbortArtifact,
} from './chatMessageLayout';

describe('getAssistantMessageBottomPaddingClass', () => {
    test('removes bottom padding only for streaming assistant placeholders with a header and no content', () => {
        expect(getAssistantMessageBottomPaddingClass({
            isUser: false,
            isFollowedByAssistant: false,
            isPlaceholderOnlyStreaming: true,
            isTranscriptTail: true,
        })).toBe('pb-0');

        expect(getAssistantMessageBottomPaddingClass({
            isUser: false,
            isFollowedByAssistant: false,
            isPlaceholderOnlyStreaming: false,
            isTranscriptTail: false,
        })).toBe('pb-8');

        expect(getAssistantMessageBottomPaddingClass({
            isUser: true,
            isFollowedByAssistant: false,
            isPlaceholderOnlyStreaming: true,
            isTranscriptTail: false,
        })).toBe('pb-0');
    });

    test('reserves the large gap for turn boundaries, not the transcript tail before live status', () => {
        expect(getAssistantMessageBottomPaddingClass({
            isUser: false,
            isFollowedByAssistant: false,
            isPlaceholderOnlyStreaming: false,
            isTranscriptTail: true,
        })).toBe('pb-0');

        expect(getAssistantMessageBottomPaddingClass({
            isUser: false,
            isFollowedByAssistant: true,
            isPlaceholderOnlyStreaming: false,
            isTranscriptTail: false,
        })).toBe('pb-0');
    });
});

describe('getAssistantMessageTopPaddingClass', () => {
    test('preserves first-message header and non-grouped behavior', () => {
        expect(getAssistantMessageTopPaddingClass({
            isUser: false,
            shouldShowHeader: true,
            stickyUserHeader: true,
            isMobile: false,
        })).toBe('pt-6');
        expect(getAssistantMessageTopPaddingClass({
            isUser: false,
            shouldShowHeader: false,
            stickyUserHeader: true,
            isMobile: false,
        })).toBe('pt-0');
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

const header = (overrides: Partial<Parameters<typeof resolveShouldShowAssistantHeader>[0]> = {}) => (
    resolveShouldShowAssistantHeader({
        isUser: false,
        suppressAssistantHeader: false,
        messageId: 'm1',
        headerMessageId: 'm1',
        streamPhase: 'completed',
        hasStartedStreamingHeader: false,
        ...overrides,
    })
);

describe('resolveShouldShowAssistantHeader', () => {
    test('draws the header once per turn, on the nominated owner', () => {
        expect(header()).toBe(true);
        expect(header({ messageId: 'm2' })).toBe(false);
    });

    test('never draws a header for a row whose turn paints nothing', () => {
        // The repeated-header bug: several content-less turns each stamped their
        // own identical "agent · model" row above empty space.
        expect(header({ suppressAssistantHeader: true })).toBe(false);
        // Including on the ungrouped path, which otherwise always shows one.
        expect(header({ suppressAssistantHeader: true, headerMessageId: undefined })).toBe(false);
    });

    test('suppression never hides a user message', () => {
        expect(header({ isUser: true, suppressAssistantHeader: true })).toBe(true);
    });

    test('keeps the live streaming placeholder header pinned once it appears', () => {
        expect(header({ streamPhase: 'streaming' })).toBe(true);
        expect(header({ streamPhase: 'cooldown' })).toBe(true);
        // Not yet started: nothing to anchor.
        expect(header({ streamPhase: 'queued', hasStartedStreamingHeader: false })).toBe(false);
        // Already revealed: stays put through mid-turn gaps.
        expect(header({ streamPhase: 'queued', hasStartedStreamingHeader: true })).toBe(true);
    });

    test('falls back to showing the header when no turn nominates an owner', () => {
        expect(header({ headerMessageId: undefined })).toBe(true);
    });
});

describe('assistant header wiring', () => {
    test('shares the part projection with MessageBody rather than inlining it', () => {
        const source = readFileSync(new URL('./ChatMessage.tsx', import.meta.url), 'utf8');

        expect(source).toContain("import { projectAssistantDisplayParts } from './message/assistantRowContent';");
        expect(source).toContain('projectAssistantDisplayParts({');
    });
});
