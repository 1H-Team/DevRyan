import { beforeEach, describe, expect, test } from 'bun:test';

import { useUIStore } from './useUIStore';

describe('useUIStore openContextPlan', () => {
  beforeEach(() => {
    useUIStore.setState({
      contextPanelByDirectory: {},
      contextPlanMotionRequest: null,
      contextPlanMotionSequence: 0,
      pendingFileFocusPath: null,
      pendingFileNavigation: null,
    });
  });

  test('opens the saved plan revision and requests an entrance from a closed panel', () => {
    useUIStore.getState().openContextPlan('/repo/Test', '/plans/session-msg.md');

    const state = useUIStore.getState();
    const panel = state.contextPanelByDirectory['/repo/Test'];
    expect(panel?.isOpen).toBe(true);
    expect(panel?.tabs.find((tab) => tab.mode === 'plan')?.targetPath).toBe('/plans/session-msg.md');
    expect(state.contextPlanMotionRequest).toEqual({
      id: 1,
      directory: '/repo/Test',
      direction: 'enter',
    });
  });

  test('toggles a closed panel open to the saved plan revision', () => {
    useUIStore.getState().toggleContextPlan('/repo/Test/', '/plans/session-msg.md');

    const state = useUIStore.getState();
    const panel = state.contextPanelByDirectory['/repo/Test'];
    expect(panel?.isOpen).toBe(true);
    expect(panel?.tabs.find((tab) => tab.mode === 'plan')?.targetPath).toBe('/plans/session-msg.md');
    expect(state.contextPlanMotionRequest).toEqual({
      id: 1,
      directory: '/repo/Test',
      direction: 'enter',
    });
  });

  test('toggles an active plan through the animated panel exit path', () => {
    useUIStore.getState().toggleContextPlan('/repo/Test', '/plans/session-msg.md');
    const entranceRequest = useUIStore.getState().contextPlanMotionRequest;
    if (entranceRequest) {
      useUIStore.getState().consumeContextPlanMotionRequest(entranceRequest.id);
    }

    useUIStore.getState().toggleContextPlan('/repo/Test', '/plans/session-msg.md');

    const state = useUIStore.getState();
    expect(state.contextPanelByDirectory['/repo/Test']?.isOpen).toBe(true);
    expect(state.contextPlanMotionRequest).toEqual({
      id: 2,
      directory: '/repo/Test',
      direction: 'exit',
    });
  });

  test('toggles an open non-plan panel to Plan instead of closing it', () => {
    useUIStore.getState().openContextFile('/repo/Test', '/repo/Test/src/main.tsx');

    useUIStore.getState().toggleContextPlan('/repo/Test', '/plans/session-msg.md');

    const state = useUIStore.getState();
    const panel = state.contextPanelByDirectory['/repo/Test'];
    const activeTab = panel?.tabs.find((tab) => tab.id === panel.activeTabId);
    expect(panel?.isOpen).toBe(true);
    expect(activeTab?.mode).toBe('plan');
    expect(activeTab?.targetPath).toBe('/plans/session-msg.md');
    expect(state.contextPlanMotionRequest).toBeNull();
  });

  test('opens ordinary files without requesting panel motion', () => {
    useUIStore.getState().openContextFile('/repo/Test', '/repo/Test/src/main.tsx');

    const state = useUIStore.getState();
    expect(state.contextPanelByDirectory['/repo/Test']?.isOpen).toBe(true);
    expect(state.contextPlanMotionRequest).toBeNull();
    expect(state.contextPlanMotionSequence).toBe(0);
  });

  test('switches an already-open file panel to Plan without replaying the entrance', () => {
    useUIStore.getState().openContextFile('/repo/Test', '/repo/Test/src/main.tsx');
    useUIStore.getState().openContextPlan('/repo/Test', '/plans/session-msg.md');

    const state = useUIStore.getState();
    const panel = state.contextPanelByDirectory['/repo/Test'];
    expect(panel?.tabs.find((tab) => tab.mode === 'plan')?.targetPath).toBe('/plans/session-msg.md');
    expect(state.contextPlanMotionRequest).toBeNull();
    expect(state.contextPlanMotionSequence).toBe(0);
  });

  test('issues a fresh entrance request when a plan is toggled open after closing', () => {
    useUIStore.getState().toggleContextPlan('/repo/Test', '/plans/session-msg.md');
    const firstRequest = useUIStore.getState().contextPlanMotionRequest;
    expect(firstRequest?.direction).toBe('enter');

    if (firstRequest) {
      useUIStore.getState().consumeContextPlanMotionRequest(firstRequest.id);
    }
    useUIStore.getState().closeContextPanel('/repo/Test');
    useUIStore.getState().toggleContextPlan('/repo/Test', '/plans/session-msg.md');

    const secondRequest = useUIStore.getState().contextPlanMotionRequest;
    expect(secondRequest?.direction).toBe('enter');
    expect(secondRequest?.id).toBeGreaterThan(firstRequest?.id ?? 0);
  });

  test('keeps an open plan mounted while requesting its animated panel exit', () => {
    useUIStore.getState().openContextPlan('/repo/Test', '/plans/session-msg.md');
    const entranceRequest = useUIStore.getState().contextPlanMotionRequest;
    if (entranceRequest) {
      useUIStore.getState().consumeContextPlanMotionRequest(entranceRequest.id);
    }

    useUIStore.getState().requestContextPanelClose('/repo/Test');

    const state = useUIStore.getState();
    expect(state.contextPanelByDirectory['/repo/Test']?.isOpen).toBe(true);
    expect(state.contextPlanMotionRequest).toEqual({
      id: 2,
      directory: '/repo/Test',
      direction: 'exit',
    });
  });

  test('closes non-plan panels immediately without requesting exit motion', () => {
    useUIStore.getState().openContextFile('/repo/Test', '/repo/Test/src/main.tsx');
    useUIStore.getState().requestContextPanelClose('/repo/Test');

    const state = useUIStore.getState();
    expect(state.contextPanelByDirectory['/repo/Test']?.isOpen).toBe(false);
    expect(state.contextPlanMotionRequest).toBeNull();
  });

  test('requests exit motion only when closing the sole plan tab', () => {
    useUIStore.getState().openContextPlan('/repo/Test', '/plans/session-msg.md');
    const entranceRequest = useUIStore.getState().contextPlanMotionRequest;
    if (entranceRequest) {
      useUIStore.getState().consumeContextPlanMotionRequest(entranceRequest.id);
    }

    const panel = useUIStore.getState().contextPanelByDirectory['/repo/Test'];
    const planTabID = panel?.tabs.find((tab) => tab.mode === 'plan')?.id;
    expect(planTabID).toBeTruthy();
    if (!planTabID) return;

    useUIStore.getState().requestContextPanelTabClose('/repo/Test', planTabID);

    const state = useUIStore.getState();
    expect(state.contextPanelByDirectory['/repo/Test']?.tabs).toHaveLength(1);
    expect(state.contextPlanMotionRequest).toEqual({
      id: 2,
      directory: '/repo/Test',
      direction: 'exit',
      closeTabID: planTabID,
    });
  });

  test('does not include transient motion state in persisted UI preferences', () => {
    useUIStore.getState().openContextPlan('/repo/Test', '/plans/session-msg.md');

    const partialize = useUIStore.persist.getOptions().partialize;
    expect(partialize).toBeTruthy();
    const persistedState = partialize?.(useUIStore.getState()) as Record<string, unknown> | undefined;
    expect(persistedState).toBeTruthy();
    expect(Boolean(persistedState && 'contextPlanMotionRequest' in persistedState)).toBe(false);
    expect(Boolean(persistedState && 'contextPlanMotionSequence' in persistedState)).toBe(false);
  });
});
