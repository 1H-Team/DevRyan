import { afterAll, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import React, { act } from 'react';
import { withDom, type HostElement } from '@/test/mountedDom';
import { dict as enMessages } from '@/lib/i18n/messages/en';

const testDir = dirname(fileURLToPath(import.meta.url));
const readSource = (path: string) => readFileSync(resolve(testDir, path), 'utf8');

const sessions: Array<Record<string, unknown>> = [];
const syncModule = { ...(await import('@/sync/sync-context')) };
mock.module('@/sync/sync-context', () => ({
    ...syncModule,
    useSessions: () => sessions,
    useAllSessionStatuses: () => ({}),
    useDirectorySync: () => undefined,
    useIsSessionWorking: () => false,
}));
const themeModule = { ...(await import('@/contexts/useThemeSystem')) };
mock.module('@/contexts/useThemeSystem', () => ({
    ...themeModule,
    useThemeSystem: () => ({
        currentTheme: { metadata: { variant: 'dark' }, colors: { surface: { foreground: '#fff' } } },
    }),
}));

const { MobileSessionStatusBar } = await import('./MobileSessionStatusBar');
const { MobileAgentButton } = await import('./MobileAgentButton');
const { MobileModelButton } = await import('./MobileModelButton');
const { I18nProvider } = await import('@/lib/i18n/context');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { useSelectionStore } = await import('@/sync/selection-store');
const { useConfigStore } = await import('@/stores/useConfigStore');
const { useUIStore } = await import('@/stores/useUIStore');
const { useProjectsStore } = await import('@/stores/useProjectsStore');

// Stores are module singletons shared across test files in one bun process; put them back.
const storeSnapshots = [useSessionUIStore, useSelectionStore, useConfigStore, useUIStore, useProjectsStore]
    .map((store) => [store, store.getState()] as const);
afterAll(() => {
    for (const [store, state] of storeSnapshots) (store as { setState: (value: unknown, replace: boolean) => void }).setState(state, true);
});

const mount = async (element: React.ReactElement, run: (container: HostElement) => Promise<void>) => {
    await withDom(async (container) => {
        const { createRoot } = await import('react-dom/client');
        const root = createRoot(container as unknown as Element);
        try {
            await act(async () => root.render(<I18nProvider>{element}</I18nProvider>));
            await run(container);
        } finally {
            await act(async () => root.unmount());
        }
    });
};

const walk = (node: HostElement, visit: (node: HostElement) => void) => {
    visit(node);
    for (const child of node.childNodes) if ('attributes' in child) walk(child as HostElement, visit);
};
const all = (container: HostElement, predicate: (node: HostElement) => boolean) => {
    const found: HostElement[] = [];
    walk(container, (node) => { if (predicate(node)) found.push(node); });
    return found;
};
const byTitle = (container: HostElement, title: string) => container.find((node) => node.getAttribute('title') === title);
const classOf = (node: HostElement | null) => node?.getAttribute('class') ?? '';

type StatusBarSetup = {
    currentSessionId?: string | null;
    draftOpen?: boolean;
    projectPath?: string | null;
    projectName?: string;
    title?: string;
};

const setUpStatusBar = ({ currentSessionId = 'ses_1', draftOpen = false, projectPath = '/work/alpha', projectName = 'alpha', title = 'Short chat' }: StatusBarSetup = {}) => {
    const openNewSessionDraft = mock(() => undefined);
    sessions.length = 0;
    // Another session exists, so only the draft rule can hide the strip when nothing is selected.
    sessions.push({ id: 'ses_other', title: 'Other', directory: '/work/alpha', time: { created: 0, updated: 0 } });
    if (currentSessionId) sessions.push({ id: currentSessionId, title, directory: projectPath ?? '/work/alpha', time: { created: 1, updated: 2 } });
    useSessionUIStore.setState({
        currentSessionId,
        currentDraftId: draftOpen ? 'draft_1' : null,
        newSessionDraft: draftOpen ? { open: true } : { open: false },
        openNewSessionDraft,
    } as never);
    useUIStore.setState({
        isMobile: true,
        showMobileSessionStatusBar: true,
        isMobileSessionStatusBarCollapsed: true,
    } as never);
    const activeProject = projectPath ? { id: 'p1', path: projectPath, label: projectName } : null;
    useProjectsStore.setState({ getActiveProject: () => activeProject } as never);
    useConfigStore.setState({ agents: [] } as never);
    return { openNewSessionDraft };
};

describe('mobile chat layout refinement', () => {
    test('mobile status strip hides for unsent new chat drafts', async () => {
        setUpStatusBar({ currentSessionId: null, draftOpen: true });
        await mount(<MobileSessionStatusBar />, async (container) => {
            expect(container.textContent).toBe('');
        });
        setUpStatusBar({ currentSessionId: null, draftOpen: false });
        await mount(<MobileSessionStatusBar />, async (container) => {
            expect(container.textContent).toContain(enMessages['chat.mobileStatus.swipeHint']);
        });

        // An open draft does not hide the strip once a session is selected.
        setUpStatusBar({ currentSessionId: 'ses_1', draftOpen: true });
        await mount(<MobileSessionStatusBar />, async (container) => {
            expect(container.textContent).toContain(enMessages['chat.mobileStatus.swipeHint']);
        });
    });

    test('mobile status strip removes project-dialog wiring and creates a new chat from the active project', async () => {
        const { openNewSessionDraft } = setUpStatusBar();
        await mount(<MobileSessionStatusBar />, async (container) => {
            const addButtons = all(container, (node) => node.getAttribute('aria-label') === enMessages['sessions.sidebar.project.actions.newDraftSession']);
            expect(addButtons).toHaveLength(1);
            await act(async () => { addButtons[0].click(); });
            expect(openNewSessionDraft).toHaveBeenCalledTimes(1);
            expect(openNewSessionDraft).toHaveBeenCalledWith({ directoryOverride: '/work/alpha' });
        });
        // No project dialog entry point remains in the strip.
        expect(readSource('MobileSessionStatusBar.tsx')).not.toContain('requestDirectoryDialog');
    });

    test('swipe hint is centered and has no decorative arrows', async () => {
        setUpStatusBar();
        expect(enMessages['chat.mobileStatus.swipeHint']).toBe('Swipe here to open sidebars');
        await mount(<MobileSessionStatusBar />, async (container) => {
            const hint = container.find((node) => node.tagName === 'BUTTON' && node.textContent === 'Swipe here to open sidebars');
            expect(hint).not.toBeNull();
            expect(classOf(hint)).toContain('flex h-8 w-full items-center justify-center');
            expect(container.textContent).not.toContain('←');
            expect(container.textContent).not.toContain('→');
        });
    });

    test('project and chat labels are character-limited before CSS truncation', async () => {
        const longProject = 'a-very-long-project-name-here';
        const longChat = 'An extremely long chat title that keeps going on';
        setUpStatusBar({ projectName: longProject, title: longChat });
        await mount(<MobileSessionStatusBar />, async (container) => {
            const project = byTitle(container, longProject);
            const chat = byTitle(container, longChat);
            expect(project?.textContent).toBe(`${longProject.slice(0, 15)}...`);
            expect(project?.textContent?.length).toBe(18);
            expect(chat?.textContent).toBe(`${longChat.slice(0, 25)}...`);
            expect(chat?.textContent?.length).toBe(28);
        });

        setUpStatusBar({ projectName: 'alpha', title: 'Short chat' });
        await mount(<MobileSessionStatusBar />, async (container) => {
            expect(byTitle(container, 'alpha')?.textContent).toBe('alpha');
            expect(byTitle(container, 'Short chat')?.textContent).toBe('Short chat');
        });
    });

    test('mobile session rows use the shared lifecycle indicator contract', () => {
        // Source contract: the indicator subscribes to several sync-store slices that have no
        // lightweight render path here.
        const source = readSource('MobileSessionStatusBar.tsx');
        const indicatorStart = source.indexOf('function MobileSessionLifecycleIndicator');
        const indicatorEnd = source.indexOf('function SessionItem', indicatorStart);
        const indicator = source.slice(indicatorStart, indicatorEnd);

        expect(indicatorStart).toBeGreaterThan(-1);
        expect(indicator).toContain('resolveSidebarWorkingStatus');
        expect(indicator).toContain('resolveSidebarIndicator');
        expect(indicator).toContain('resolveSessionLeadingIndicatorPresentation');
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

        expect(indicator).toContain('<SessionStatusDot');
        expect(indicator).toContain('resolveSessionLeadingIndicatorLabelKey(presentation)');
        expect(indicator).toContain('label={labelKey ? t(labelKey) : undefined}');
        expect(indicator).not.toContain('animate-spin');
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

    test('a normal mobile agent tap always opens the full picker instead of cycling', async () => {
        useSessionUIStore.setState({ currentSessionId: null } as never);
        useConfigStore.setState({ agents: [], currentAgentName: 'orchestrator' } as never);
        const onOpenAgentPanel = mock(() => undefined);
        await mount(<MobileAgentButton onOpenAgentPanel={onOpenAgentPanel} />, async (container) => {
            const button = container.find((node) => node.tagName === 'BUTTON');
            await act(async () => { button?.click(); });
            expect(onOpenAgentPanel).toHaveBeenCalledTimes(1);
            // Touch handling only prevents focus theft; there is no long-press or cycle timer to wait on.
            expect(button?.listeners.has('pointerdown')).toBe(false);
        });

        const chatInput = readSource('ChatInput.tsx');
        const footer = chatInput.slice(chatInput.indexOf('data-chat-input-footer="true"'));
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
        // The MessageBody gap and ReasoningPart padding halves of this contract are rendered in
        // message/MessageBody.spacing.test.tsx; the stylesheet has no runtime here.
        const mobileStyles = readSource('../../styles/mobile.css');

        expect(mobileStyles).toContain(':root.device-mobile:not(.desktop-runtime) {\n    font-size: 90%;');
        expect(mobileStyles).toContain('font-size: 16px !important; /* Prevents iOS zoom */');
        expect(mobileStyles).toContain('min-height: 36px;');
    });

    test('puts mobile agent and model metadata in the requested icon and thinking order', async () => {
        useSessionUIStore.setState({ currentSessionId: null } as never);
        useSelectionStore.setState({ defaultPlanModeSelection: false } as never);
        useConfigStore.setState({
            agents: [{ name: 'orchestrator', mode: 'primary' }],
            currentAgentName: 'orchestrator',
            providers: [{ id: 'openai', models: [{ id: 'gpt-x', name: 'GPT X', variants: { high: {}, low: {} } }] }],
            currentProviderId: 'openai',
            currentModelId: 'gpt-x',
            currentVariant: 'high',
        } as never);

        await mount(<MobileAgentButton onOpenAgentPanel={() => undefined} />, async (container) => {
            const button = container.find((node) => node.tagName === 'BUTTON');
            const children = (button?.childNodes ?? []) as HostElement[];
            expect(children[0]?.tagName).toBe('SVG');
            expect(children[0]?.getAttribute('aria-hidden')).toBe('true');
            expect(classOf(children[0])).toContain('mr-1 h-3 w-3 shrink-0');
            expect(children[1]?.textContent).toBe('Orchestrator');
            expect(classOf(button)).toContain('min-w-[30px]');
            expect(children).toHaveLength(2);
        });

        useSelectionStore.setState({ defaultPlanModeSelection: true } as never);
        await mount(<MobileAgentButton onOpenAgentPanel={() => undefined} />, async (container) => {
            const button = container.find((node) => node.tagName === 'BUTTON');
            const children = (button?.childNodes ?? []) as HostElement[];
            // Plan mode reserves room for both glyphs and adds the trailing plan icon.
            expect(classOf(button)).toContain('min-w-[48px]');
            expect(children).toHaveLength(3);
            expect(classOf(children[2])).toContain('ml-1 h-3 w-3 shrink-0');
        });

        await mount(<MobileModelButton onOpenModel={() => undefined} />, async (container) => {
            const button = container.find((node) => node.tagName === 'BUTTON');
            expect(classOf(button)).toContain('justify-center overflow-hidden');
            expect(button?.textContent).toMatch(/^GPT X·\S+/);
            const separator = all(container, (node) => node.getAttribute('aria-hidden') === 'true');
            expect(separator).toHaveLength(1);
            expect(separator[0].textContent).toBe('·');
            expect(button?.getAttribute('title')).toContain('GPT X · ');
        });

        useConfigStore.setState({ currentVariant: undefined, providers: [{ id: 'openai', models: [{ id: 'gpt-x', name: 'GPT X' }] }] } as never);
        await mount(<MobileModelButton onOpenModel={() => undefined} />, async (container) => {
            expect(all(container, (node) => node.getAttribute('aria-hidden') === 'true')).toHaveLength(0);
            expect(container.find((node) => node.tagName === 'BUTTON')?.textContent).toBe('GPT X');
        });
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
