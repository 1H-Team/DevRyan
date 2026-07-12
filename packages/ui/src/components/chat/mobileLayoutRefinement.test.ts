import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));

const readSource = (path: string) => readFileSync(resolve(testDir, path), 'utf8');

describe('mobile chat layout refinement', () => {
    test('mobile status strip hides for unsent new chat drafts', () => {
        const source = readSource('MobileSessionStatusBar.tsx');

        expect(source).toContain('const newSessionDraftOpen = useSessionUIStore((state) => Boolean(state.currentDraftId && state.newSessionDraft?.open));');
        expect(source).toContain('newSessionDraftOpen && !currentSessionId');
    });

    test('mobile status strip removes project-dialog wiring and creates a new chat from the active project', () => {
        const source = readSource('MobileSessionStatusBar.tsx');

        expect(source).not.toContain('sessionEvents.requestDirectoryDialog');
        expect(source).not.toContain('onAddProject');
        expect(source).toContain('openNewSessionDraft({ directoryOverride: activeProject.path })');
    });

    test('swipe hint is centered and has no decorative arrows', () => {
        const source = readSource('MobileSessionStatusBar.tsx');
        const messages = readFileSync(resolve(testDir, '../../lib/i18n/messages/en.ts'), 'utf8');

        expect(messages).toContain("'chat.mobileStatus.swipeHint': 'Swipe here to open sidebars'");
        expect(messages).not.toContain('← Swipe here to open sidebars →');
        expect(source).toContain('className="flex h-8 w-full items-center justify-center');
    });

    test('project and chat labels are character-limited before CSS truncation', () => {
        const source = readSource('MobileSessionStatusBar.tsx');

        expect(source).toContain('truncateLabel(projectName, 18)');
        expect(source).toContain('truncateLabel(chatName, 28)');
        expect(source).toContain('title={projectName}');
        expect(source).toContain('title={chatName}');
    });

    test('mobile composer shows agent before model and omits the command button', () => {
        const source = readSource('ChatInput.tsx');
        const footer = source.slice(source.indexOf('data-chat-input-footer="true"'));
        const agentIndex = footer.indexOf('<MemoMobileAgentButton');
        const modelIndex = footer.indexOf('<MemoMobileModelButton');

        expect(agentIndex).toBeGreaterThan(-1);
        expect(modelIndex).toBeGreaterThan(-1);
        expect(agentIndex).toBeLessThan(modelIndex);
        expect(source).not.toContain('<RiCommandLine className={cn(iconSizeClass)} />');
    });

    test('mobile composer does not render the duplicate inline model controls', () => {
        const chatInput = readSource('ChatInput.tsx');
        const modelControls = readSource('ModelControls.tsx');

        expect(chatInput).toContain('<MemoModelControls\n                                    hideInlineControls');
        expect(modelControls).toContain('{!hideInlineControls ? (');
    });
});
