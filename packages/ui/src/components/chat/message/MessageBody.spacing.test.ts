import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

const testDir = dirname(fileURLToPath(import.meta.url));
const read = (path: string): string => readFileSync(resolve(testDir, path), 'utf8');

describe('session output spacing', () => {
    test('centralizes the top-level vertical rhythm in MessageBody', () => {
        const source = read('MessageBody.tsx');

        expect(source).toContain('message-content-text flex flex-col leading-relaxed');
        expect(source).toContain("isMobile ? 'gap-y-1' : 'gap-y-1.5'");
        expect(source).toContain('data-session-output-stack="true"');
        expect(source).not.toContain('key={`progressive-group-${segment.id}`} className="mb-3"');
        expect(source).not.toContain("'group/assistant-text relative mt-3 break-words max-w-full'");
        // Exterior markdown edge-margins are now stripped via scoped CSS, not
        // partial last-child utilities on the parent stack.
        expect(source).not.toContain('[&_p:last-child]:mb-0');
    });

    test('flattens markdown exterior margins inside the session output stack', () => {
        const css = read('../../../index.css');

        expect(css).toContain('[data-session-output-stack="true"] .markdown-content > :first-child');
        expect(css).toContain('[data-session-output-stack="true"] .markdown-content > :last-child');
    });

    test('keeps Live and Sorted assistant text on the same exterior-spacing contract', () => {
        const source = read('parts/AssistantTextPart.tsx');

        // Assistant text shares the same symmetric row padding as reasoning/tool rows.
        expect(source).toContain("cn('group/assistant-text relative break-words', isMobile ? 'py-1' : 'py-1.5')");
        expect(source).not.toContain("chatRenderMode === 'live' ? 'my-1' : ''");
    });

    test('removes child-owned exterior margins and shares symmetric row padding', () => {
        const reasoning = read('parts/ReasoningPart.tsx');
        const progressiveGroup = read('parts/ProgressiveGroup.tsx');
        const planCard = read('parts/PlanCard.tsx');
        const toolPart = read('parts/ToolPart.tsx');
        const staticToolRow = read('parts/StaticToolRow.tsx');

        expect(reasoning).not.toContain('className="my-1" data-reasoning-block-id');
        expect(reasoning).not.toContain('className="my-1 typography-meta text-muted-foreground"');
        // The timeline block owns the responsive row padding without exterior
        // margins; the empty-active "Thinking…" placeholder is gone (the bottom
        // status row owns that indicator).
        expect(reasoning.match(/isMobile \? 'relative pr-2 py-1' : 'relative pr-2 py-1\.5'/g)).toHaveLength(1);

        expect(progressiveGroup).not.toContain('className="mt-1 mb-2 space-y-1.5"');
        expect(progressiveGroup).not.toContain('className="mt-1 mb-2"');
        expect(progressiveGroup).toContain('className="space-y-1.5"');
        expect(planCard).not.toContain('className="my-4 overflow-hidden rounded-xl');
        expect(planCard).toContain('className="overflow-hidden rounded-xl border border-border bg-card"');

        expect(toolPart).toContain("'group/tool flex gap-1.5 pr-2 pl-px py-1.5 rounded-xl'");
        expect(staticToolRow).toContain("'flex w-full items-center gap-x-1.5 pr-2 pl-px py-1.5 rounded-xl min-w-0'");
        expect(progressiveGroup).toContain('pr-2 pl-px py-1.5 rounded-xl text-left min-w-0');
    });
});
