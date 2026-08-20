import type { Part, ToolPart } from '@opencode-ai/sdk/v2';

import type { TurnActivityRecord } from '../../lib/turns/types';
import { isToolPartFinalizedForDisplay } from './toolDisplayState';
import { normalizeToolName } from './toolRenderUtils';

export interface GeneratedImageResult {
    toolPartId: string;
    path: string;
    filename: string;
    directory?: string;
    linkedMessageId?: string;
    linkLabel?: string;
}

export type GeneratedImageMarkdownSegment =
    | { type: 'markdown'; content: string }
    | { type: 'image'; result: GeneratedImageResult };

export const buildGeneratedImageRawUrl = (path: string, directory?: string): string => {
    const params = new URLSearchParams({ path });
    if (directory?.trim()) params.set('directory', directory.trim());
    return `/api/fs/raw?${params.toString()}`;
};

interface AssistantMessageParts {
    messageId: string;
    parts: Part[];
}

const readTextPart = (part: Part): string => {
    const candidate = part as Part & { text?: unknown; content?: unknown; value?: unknown };
    const values = [candidate.text, candidate.content, candidate.value]
        .filter((value): value is string => typeof value === 'string');
    return values.reduce((longest, value) => value.length > longest.length ? value : longest, '');
};

const decodePath = (value: string): string => {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
};

const normalizeComparablePath = (value: string): string => {
    const normalized = value.replace(/\\/g, '/');
    return /^\/[A-Za-z]:\//.test(normalized) ? normalized.slice(1) : normalized;
};

export const normalizeGeneratedImageLinkTarget = (value: string): string | null => {
    let target = value.trim();
    if (target.startsWith('<') && target.endsWith('>')) {
        target = target.slice(1, -1).trim();
    }
    if (!target) return null;

    try {
        const url = new URL(target, 'https://devryan.invalid');
        if (url.protocol === 'file:') {
            return decodePath(url.pathname);
        }
        if (url.origin === 'https://devryan.invalid' && url.pathname === '/api/fs/raw') {
            const path = url.searchParams.get('path');
            return path ? decodePath(path) : null;
        }
    } catch {
        // Plain filesystem paths are handled below.
    }

    return decodePath(target);
};

const STANDALONE_MARKDOWN_LINK = /^\s*\[([^\]]+)\]\((<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\)\s*$/;

export const matchGeneratedImageStandaloneLink = (
    line: string,
    results: readonly GeneratedImageResult[],
): { result: GeneratedImageResult; label: string } | null => {
    const match = line.match(STANDALONE_MARKDOWN_LINK);
    if (!match) return null;

    const target = normalizeGeneratedImageLinkTarget(match[2] ?? '');
    if (!target) return null;
    const comparableTarget = normalizeComparablePath(target);
    const result = results.find((candidate) => normalizeComparablePath(candidate.path) === comparableTarget);
    return result ? { result, label: match[1]?.trim() || result.filename } : null;
};

export const extractGeneratedImageResults = (
    activities: readonly TurnActivityRecord[],
): GeneratedImageResult[] => {
    const results: GeneratedImageResult[] = [];
    const seen = new Set<string>();

    for (const activity of activities) {
        if (activity.kind !== 'tool') continue;
        const part = activity.part as ToolPart;
        if (normalizeToolName(part.tool) !== 'gpt_imagegen' || !isToolPartFinalizedForDisplay(part)) continue;

        const state = part.state as { metadata?: Record<string, unknown> } | undefined;
        const outputPath = typeof state?.metadata?.out === 'string' ? state.metadata.out.trim() : '';
        if (!outputPath || seen.has(part.id)) continue;
        seen.add(part.id);

        const normalized = outputPath.replace(/\\/g, '/');
        results.push({
            toolPartId: part.id,
            path: outputPath,
            filename: normalized.split('/').pop() || 'generated-image.png',
        });
    }

    return results;
};

export const annotateGeneratedImageLinks = (
    results: readonly GeneratedImageResult[],
    messages: readonly AssistantMessageParts[],
): GeneratedImageResult[] => {
    const annotated = results.map((result) => ({ ...result }));
    const linkedToolIds = new Set<string>();

    for (const message of messages) {
        for (const part of message.parts) {
            if (part.type !== 'text') continue;
            for (const line of readTextPart(part).split(/\r?\n/)) {
                const matched = matchGeneratedImageStandaloneLink(line, annotated);
                if (!matched || linkedToolIds.has(matched.result.toolPartId)) continue;
                const target = annotated.find((candidate) => candidate.toolPartId === matched.result.toolPartId);
                if (!target) continue;
                target.linkedMessageId = message.messageId;
                target.linkLabel = matched.label;
                linkedToolIds.add(target.toolPartId);
            }
        }
    }

    return annotated;
};

export const splitGeneratedImageMarkdown = (
    content: string,
    messageId: string,
    results: readonly GeneratedImageResult[],
): GeneratedImageMarkdownSegment[] => {
    const linkedResults = results.filter((result) => result.linkedMessageId === messageId);
    if (linkedResults.length === 0) return [{ type: 'markdown', content }];

    const segments: GeneratedImageMarkdownSegment[] = [];
    const markdownLines: string[] = [];
    const rendered = new Set<string>();
    const flushMarkdown = () => {
        const markdown = markdownLines.join('\n');
        markdownLines.length = 0;
        if (markdown.length > 0) segments.push({ type: 'markdown', content: markdown });
    };

    for (const line of content.split(/\r?\n/)) {
        const matched = matchGeneratedImageStandaloneLink(line, linkedResults);
        if (!matched || rendered.has(matched.result.toolPartId)) {
            markdownLines.push(line);
            continue;
        }
        flushMarkdown();
        rendered.add(matched.result.toolPartId);
        segments.push({
            type: 'image',
            result: { ...matched.result, linkLabel: matched.label },
        });
    }
    flushMarkdown();

    return segments.length > 0 ? segments : [{ type: 'markdown', content }];
};
