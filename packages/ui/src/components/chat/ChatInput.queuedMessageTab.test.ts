import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const chatInputSource = readFileSync(
    fileURLToPath(new URL('./ChatInput.tsx', import.meta.url)),
    'utf8',
);

describe('ChatInput queued message tab', () => {
    test('passes suppressTab={hasQueuedMessages} and no longer references QueuedMessageChips', () => {
        expect(chatInputSource).toContain('suppressTab={hasQueuedMessages}');
        expect(chatInputSource).toContain('import { QueuedMessageTab } from \'./QueuedMessageTab\'');
        expect(chatInputSource).toContain('<QueuedMessageTab');
        expect(chatInputSource).not.toContain('QueuedMessageChips');
    });
});

describe('ChatInput Enter with a queued message', () => {
    test('keeps the Enter decision on queueModeEnabled / canQueue so an empty composer still steers', () => {
        const enterBranchStart = chatInputSource.indexOf('// Handle Enter/Ctrl+Enter based on queue mode');
        const enterBranchEnd = chatInputSource.indexOf('const measureCaretInTextarea', enterBranchStart);
        const enterBranch = chatInputSource.slice(enterBranchStart, enterBranchEnd);

        expect(enterBranchStart).toBeGreaterThan(-1);
        expect(enterBranchEnd).toBeGreaterThan(enterBranchStart);
        expect(enterBranch).toContain(
            "const canQueue = inputMode === 'normal' && hasContent && currentSessionId && !currentSessionIsSubtask && isAbortableSessionPhase(sessionPhase);",
        );
        expect(enterBranch).not.toContain('hasQueuedMessages');
        expect(enterBranch).toContain('if (queueModeEnabled)');
        expect(enterBranch).toContain('if (isCtrlEnter || !canQueue)');
        expect(enterBranch).toContain('void handleSubmit()');
        expect(enterBranch).toContain('void handleQueueMessage()');

        const handleSubmitStart = chatInputSource.indexOf('const handleSubmit = async (options?: SubmitOptions)');
        const handleSubmit = chatInputSource.slice(
            handleSubmitStart,
            chatInputSource.indexOf('handleSubmitRef.current = handleSubmit', handleSubmitStart),
        );
        expect(handleSubmit).toContain('shouldInterruptBeforeSubmit({');
        expect(handleSubmit).toContain('queuedOnly: true');
    });
});
