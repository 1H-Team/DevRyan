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
        expect(source).toContain("isMobile ? 'gap-y-2' : 'gap-y-3'");
        // The stack only needs horizontal containment. `overflow-hidden` clipped the
        // Agent Dispatch card's 1px bottom border whenever the turn continued below it
        // (the card is the last child and the wrapper drops to `pb-0`), and on mobile it
        // matched the blanket `.overflow-hidden { overflow-y: auto }` rule in mobile.css.
        expect(source).toContain('leading-relaxed overflow-x-clip text-foreground/90');
        expect(source).not.toContain('leading-relaxed overflow-hidden');
        expect(source).toContain('data-session-output-stack="true"');
        const stackMarker = source.indexOf('data-session-output-stack="true"');
        const managedTaskList = source.lastIndexOf('<ManagedTaskList');
        const stackEnd = source.indexOf('\n            </div>\n        </div>\n    );', managedTaskList);
        expect(stackMarker).toBeGreaterThan(-1);
        expect(managedTaskList).toBeGreaterThan(stackMarker);
        expect(stackEnd).toBeGreaterThan(managedTaskList);
        expect(source).toContain('const STACKED_MESSAGE_ACTIONS_CLASS_NAME = \'flex items-center justify-start gap-1.5\'');
        expect(source).toContain('className="flex items-center justify-start gap-3"');
        expect(source).not.toContain('className="mt-2 mb-1 flex items-center justify-start gap-3"');
        expect(source).not.toContain('key={`progressive-group-${segment.id}`} className="mb-3"');
        expect(source).not.toContain("'group/assistant-text relative mt-3 break-words max-w-full'");
        // Exterior markdown edge-margins are now stripped via scoped CSS, not
        // partial last-child utilities on the parent stack.
        expect(source).not.toContain('[&_p:last-child]:mb-0');
    });

    test('uses the same full rhythm step at the live status boundary after dispatch cards', () => {
        const source = read('../ChatContainer.tsx');

        expect(source).toContain("isMobile ? 'mt-3' : 'mt-4'");
        expect(source).toContain("'mb-3 min-h-[1.45rem]'");
        expect(source).not.toContain("isMobile ? 'mt-2' : 'mt-3'");
        expect(source).not.toContain("isMobile ? 'mt-1.5' : 'mt-2'");
    });

    test('uses the same rhythm for rendered assistant continuation messages only', () => {
        const message = read('../ChatMessage.tsx');
        const css = read('../../../index.css');

        expect(message).toContain("isContinuationAssistant && 'assistant-continuation-spacing'");
        expect(css).toContain('.assistant-continuation-spacing:has([data-session-output-stack="true"] > *)');
        expect(css).toContain('padding-top: 0.75rem;');
        expect(css).toContain('.device-mobile .assistant-continuation-spacing');
        expect(css).toContain('padding-top: 0.5rem;');
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
        // margins; the disclosure owns the active "Thinking…" label while this
        // expanded-body renderer remains text-only.
        expect(reasoning.match(/isMobile \? 'relative pr-2 py-1' : 'relative pr-2 py-1\.5'/g)).toHaveLength(1);

        expect(progressiveGroup).not.toContain('className="mt-1 mb-2 space-y-1.5"');
        expect(progressiveGroup).not.toContain('className="mt-1 mb-2"');
        expect(progressiveGroup.match(/isMobile \? 'space-y-2' : 'space-y-3'/g)).toHaveLength(2);
        expect(planCard).not.toContain('className="my-4 overflow-hidden rounded-xl');
        expect(planCard).toContain('className="overflow-hidden rounded-xl border border-border bg-card"');

        expect(toolPart).toContain("'group/tool flex gap-1.5 pr-2 pl-px py-1.5 rounded-xl'");
        expect(staticToolRow).toContain("'flex w-full items-center gap-x-1.5 pr-2 pl-px py-1.5 rounded-xl min-w-0'");
        expect(progressiveGroup).toContain('pr-2 pl-px py-1.5 rounded-xl text-left min-w-0');
    });
});
