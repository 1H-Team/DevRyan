import React, { act } from 'react';
import { expect, mock, test } from 'bun:test';
import type { ToolPart } from '@opencode-ai/sdk/v2';
import type { TurnActivityRecord } from '../../lib/turns/types';
import { withDom } from '../../../bots/chat/botMountedDom';

// Keep the real grouping, row keys, memo comparisons and skill text; animations
// need browser layout, which this mounted reconciliation fixture does not supply.
mock.module('../FadeInOnReveal', () => ({ FadeInOnReveal: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
mock.module('./ToolRevealOnMount', () => ({ ToolRevealOnMount: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
const { default: ProgressiveGroup } = await import('./ProgressiveGroup');

const activity = (id: string, state: ToolPart['state']): TurnActivityRecord => ({
    id, turnId: 'turn', messageId: `message-${id}`, partIndex: 0, kind: 'tool',
    part: { id, sessionID: 'session', messageID: `message-${id}`, type: 'tool', tool: 'skill', callID: `call-${id}`, state },
});

test('each skill call retains its row and static name through later loads and reload', async () => {
    await withDom(async (container) => {
        const { createRoot } = await import('react-dom/client');
        const root = createRoot(container as unknown as Element);
        const first = activity('first', { status: 'completed', input: { name: 'Release Checklist' },
            output: 'body', title: '', metadata: {}, time: { start: 1, end: 2 } });
        let parts = [first];
        const animatedToolIds = new Set(['first', 'second']);
        const render = async () => act(async () => root.render(<ProgressiveGroup parts={parts}
            isExpanded={false} collapsedPreviewCount={7} onToggle={() => {}}
            syntaxTheme={{}} isMobile={false} expandedTools={new Set()}
            onToggleTool={() => {}} onShowPopup={() => {}} streamPhase="streaming"
            showHeader animateRows={false} animatedToolIds={animatedToolIds} />));
        try {
            await render();
            const firstName = container.find(node => node.tagName === 'SPAN' && node.textContent === 'Release Checklist');
            expect(firstName).not.toBeNull();
            parts = [first, activity('second', { status: 'pending', input: {}, raw: '' })];
            await render();
            const loadingLabel = container.find(node => node.getAttribute('title') === 'Loading Skill:');
            expect(loadingLabel).not.toBeNull();
            expect(container.textContent).not.toContain('Loading Skill:Skill');
            expect(container.find(node => node.textContent === 'Release Checklist')).toBe(firstName);

            parts = [first, activity('second', { status: 'running', input: { name: 'Diagnosing Bugs' }, time: { start: 3 } })];
            await render();
            const secondName = container.find(node => node.tagName === 'SPAN' && node.textContent === 'Diagnosing Bugs');
            expect(secondName).not.toBeNull();
            expect(secondName?.childNodes.every(node => node.nodeType === 3)).toBe(true);

            parts = [first, activity('second', { status: 'completed', input: { name: 'Diagnosing Bugs' },
                output: 'body', title: '', metadata: {}, time: { start: 3, end: 4 } })];
            await render();
            expect(container.find(node => node.getAttribute('title') === 'Loaded Skill:' && node === loadingLabel)).toBe(loadingLabel);
            expect(container.find(node => node.textContent === 'Diagnosing Bugs')).toBe(secondName);
            expect(container.find(node => node.textContent === 'Release Checklist')).toBe(firstName);
            expect(container.textContent.match(/Loaded Skill:/g)).toHaveLength(2);

            await act(async () => root.render(null));
            parts = structuredClone(parts);
            await render();
            expect(container.textContent.match(/Loaded Skill:/g)).toHaveLength(2);
            expect(container.textContent).toContain('Release Checklist');
            expect(container.textContent).toContain('Diagnosing Bugs');
        } finally {
            await act(async () => root.unmount());
        }
    });
});
