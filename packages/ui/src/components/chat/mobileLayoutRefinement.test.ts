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

    test('mobile session rows use the shared lifecycle indicator contract', () => {
        const source = readSource('MobileSessionStatusBar.tsx');
        const indicatorStart = source.indexOf('function MobileSessionLifecycleIndicator');
        const indicatorEnd = source.indexOf('function SessionItem', indicatorStart);
        const indicator = source.slice(indicatorStart, indicatorEnd);

        expect(indicatorStart).toBeGreaterThan(-1);
        expect(indicator).toContain('resolveSidebarWorkingStatus');
        expect(indicator).toContain('resolveSidebarIndicator');
        expect(indicator).toContain('resolveMobileSessionIndicatorPresentation');
        expect(indicator).toContain('state.index.session.unseenHasError[sessionId]');
        expect(indicator).toContain('state.index.session.unseenHasCompletion[session.id]');
        expect(indicator).toContain('state.sessionCompletionIndicator.has(session.id)');
        expect(indicator).toContain('state.question[sessionId]?.length');
        expect(indicator).not.toContain('needsAttention');
        expect(source).toContain('collectSessionIndicatorScopeIds(session.id, parentChildMap)');
    });

    test('mobile session rows preserve accessible colored, working, and neutral markers', () => {
        const source = readSource('MobileSessionStatusBar.tsx');
        const indicatorStart = source.indexOf('function MobileSessionLifecycleIndicator');
        const indicatorEnd = source.indexOf('function SessionItem', indicatorStart);
        const indicator = source.slice(indicatorStart, indicatorEnd);

        expect(indicator).toContain("presentation.kind === 'status'");
        expect(indicator).toContain('presentation.indicator.className');
        expect(indicator).toContain("presentation.kind === 'working'");
        expect(indicator).toContain('aria-label={label}');
        expect(indicator).toContain('title={label}');
        expect(indicator).toContain('border-[var(--surface-mutedForeground)]');
        expect(indicator).toContain('aria-hidden="true"');
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

    test('a normal mobile agent tap always opens the full picker instead of cycling', () => {
        const agentButton = readSource('MobileAgentButton.tsx');
        const chatInput = readSource('ChatInput.tsx');
        const footer = chatInput.slice(chatInput.indexOf('data-chat-input-footer="true"'));

        expect(agentButton).toContain('onPointerUp={onOpenAgentPanel}');
        expect(agentButton).not.toContain('onCycleAgent');
        expect(agentButton).not.toContain('LONG_PRESS_MS');
        expect(agentButton).not.toContain('longPressTimerRef');
        expect(footer).not.toContain('onCycleAgent={handleCycleAgent}');
        expect(chatInput).toContain('handleCycleAgent();');
    });

    test('mobile agent picker pins plan first and renders colored agent glyphs before labels', () => {
        const source = readSource('ModelControls.tsx');
        const panelStart = source.indexOf('const renderMobileAgentPanel = () => {');
        const panelEnd = source.indexOf('const renderModelTooltipContent = () =>', panelStart);
        const panel = source.slice(panelStart, panelEnd);
        const planIndex = panel.indexOf("t('layout.mainTab.plan')");
        const agentsIndex = panel.indexOf('selectableAgentOptions.map((agent)');
        const iconIndex = panel.indexOf('<RiAiAgentLine');
        const labelIndex = panel.indexOf('{formatAgentLabel(agent.name)}');

        expect(planIndex).toBeGreaterThan(-1);
        expect(agentsIndex).toBeGreaterThan(planIndex);
        expect(iconIndex).toBeGreaterThan(agentsIndex);
        expect(labelIndex).toBeGreaterThan(iconIndex);
        expect(panel).toContain('getAgentIconColor(agent.name)');
        expect(panel).toContain('className="h-4 w-4 flex-shrink-0"');
        expect(panel).toContain('className="min-w-0 flex-1 truncate typography-ui-label font-semibold"');
    });

    test('keeps density and assistant output rhythm scoped to true mobile devices', () => {
        const mobileStyles = readSource('../../styles/mobile.css');
        const messageBody = readSource('message/MessageBody.tsx');
        const reasoningPart = readSource('message/parts/ReasoningPart.tsx');

        expect(mobileStyles).toContain(':root.device-mobile:not(.desktop-runtime) {\n    font-size: 90%;');
        expect(mobileStyles).toContain('font-size: 16px !important; /* Prevents iOS zoom */');
        expect(mobileStyles).toContain('min-height: 36px;');
        expect(messageBody).toContain("isMobile ? 'gap-y-2' : 'gap-y-3'");
        expect(messageBody).toContain('isMobile={isMobile}');
        expect(reasoningPart).toContain('isMobile?: boolean');
        expect(reasoningPart).toContain("isMobile ? 'relative pr-2 py-1' : 'relative pr-2 py-1.5'");
    });

    test('puts mobile agent and model metadata in the requested icon and thinking order', () => {
        const agentButton = readSource('MobileAgentButton.tsx');
        const modelButton = readSource('MobileModelButton.tsx');

        expect(agentButton).toContain('RiAiAgentLine');
        expect(agentButton.indexOf('<RiAiAgentLine')).toBeLessThan(agentButton.indexOf('<span className="min-w-0 flex-1 truncate">{agentLabel}</span>'));
        expect(agentButton).toContain('getAgentIconColor');
        expect(agentButton).toContain('style={isPlanModeSelected ? PLAN_MODE_AGENT_STYLE');
        expect(agentButton).toContain('style={PLAN_MODE_AGENT_STYLE}');
        expect(agentButton).toContain("isPlanModeSelected ? 'min-w-[48px]' : 'min-w-[30px]'");
        expect(agentButton).toContain('className="mr-1 h-3 w-3 shrink-0"');
        expect(agentButton).toContain('className="ml-1 h-3 w-3 shrink-0"');
        expect(modelButton).toContain('getModelThinkingLevelLabel');
        expect(modelButton).toContain('modelThinkingLabel');
        expect(modelButton).toContain('aria-hidden="true">·</span>');
        expect(modelButton).toContain('justify-center overflow-hidden');
    });

    test('reserves plan glyph space before shrinking mobile model metadata', () => {
        const source = readSource('ChatInput.tsx');
        const footer = source.slice(source.indexOf('data-chat-input-footer="true"'));
        const agentIndex = footer.indexOf('<MemoMobileAgentButton');
        const modelIndex = footer.indexOf('<MemoMobileModelButton');

        expect(footer).toContain('className="flex min-w-0 flex-1 items-center justify-end gap-x-1"');
        expect(footer).toContain('className="flex min-w-0 max-w-[60vw] flex-1 items-center justify-end gap-x-1"');
        expect(footer.slice(agentIndex, modelIndex)).toContain('className="flex-[0_1_auto]"');
        expect(footer.slice(modelIndex, modelIndex + 180)).toContain('className="min-w-0 flex-1"');
    });

    test('shows the direct queue action only for mobile abortable root-session turns', () => {
        const source = readSource('ChatInput.tsx');

        expect(source).toContain('const canQueueDuringActiveTurn =');
        expect(source).toContain('isMobile && inputMode === \'normal\'');
        expect(source).toContain('!currentSessionIsSubtask');
        expect(source).toContain('canQueue={canQueueDuringActiveTurn}');
        expect(source).toContain('onQueue={handleQueueMessage}');
        expect(source).toContain('onPointerDown={preserveComposerFocus}');
        expect(source).toContain('onMouseDown={preserveComposerFocus}');
        expect(source).toContain('event.preventDefault();\n                        onQueue();');
        expect(source).toContain("t('chat.chatInput.actions.queueMessageAria')");
    });
});
