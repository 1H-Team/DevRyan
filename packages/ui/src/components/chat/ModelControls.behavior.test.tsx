import { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Part, TextPart, UserMessage } from '@opencode-ai/sdk/v2';

import type { HostElement } from '@/components/bots/chat/botMountedDom';
import {
  baseModel,
  directoryStore,
  sessionID,
  useConfigStore,
  useContextStore,
  useSelectionStore,
  useSessionUIStore,
  useUIStore,
  withModelControls,
} from './modelControlsTestHarness';

// Behavioural replacements for the ModelControls source-text contracts. The
// real component, stores and effects run; see modelControlsTestHarness.tsx.
const textPart = (messageID: string): TextPart => ({ id: `prt_${messageID}`, sessionID, messageID, type: 'text', text: 'Do the work.' });
const userMessage = (id: string, choice: { providerID: string; modelID: string; variant?: string }, agent = 'builder'): UserMessage => ({
  id, sessionID, role: 'user', agent, time: { created: 2 }, model: choice,
});
const button = (container: HostElement, prefix: string) => container.find((node) => node.tagName === 'BUTTON' && node.textContent.startsWith(prefix));
const modelLabel = (container: HostElement) => container.find((node) => (node.getAttribute('class') ?? '').includes('marquee-text'))?.textContent;

const realFetch = globalThis.fetch;
let fetched: string[] = [];
beforeEach(() => {
  fetched = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    fetched.push(String(input));
    return Response.json({});
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

describe('composer account-default isolation', () => {
  test('does not persist composer model changes as managed account defaults', async () => {
    const persisted: unknown[][] = [];
    await withModelControls(async (container) => {
      useConfigStore.setState({
        persistAgentModelSelection: async (...args: unknown[]) => { persisted.push(args); },
        resetAgentModelSelection: async (...args: unknown[]) => { persisted.push(args); },
      } as never);
      await act(async () => { button(container, 'Alternate Model')!.click(); });
      // The pick took effect locally...
      expect(useConfigStore.getState().currentModelId).toBe('alternate');
    });
    // ...but never reached the account-level agent defaults.
    expect(persisted).toEqual([]);
    expect(fetched.filter((url) => url.includes('/agent-defaults/'))).toEqual([]);
  });
});

describe('ModelControls hidden-model fallback', () => {
  test('preserves the provider selected in settings while choosing a visible fallback model', async () => {
    await withModelControls(async () => {
      expect(useConfigStore.getState().currentModelId).toBe('alternate');
      expect(useConfigStore.getState().currentProviderId).toBe('fixture');
      expect(useConfigStore.getState().selectedProviderId).toBe('settings-provider');
    }, {
      beforeMount: () => {
        useConfigStore.setState({ selectedProviderId: 'settings-provider' });
        useUIStore.setState({ hiddenModels: [{ providerID: 'fixture', modelID: 'model' }] });
        // No open session: saved-selection restoration would otherwise run first.
        useSessionUIStore.setState({ currentSessionId: null });
      },
      panel: 'agent',
    });
  });
});

describe('ModelControls current model label', () => {
  test('resolves a hidden current model name from the unfiltered provider catalog', async () => {
    await withModelControls(async (container) => {
      expect(modelLabel(container)).toBe('Fixture Model');
    }, {
      beforeMount: () => {
        useConfigStore.setState({
          providers: [{ id: 'fixture', name: 'Fixture', source: 'custom', options: {}, env: [], models: [baseModel] }],
        });
        useUIStore.setState({ hiddenModels: [{ providerID: 'fixture', modelID: 'model' }] });
      },
    });
  });

  test('falls back to the raw model id only when the catalog has no entry', async () => {
    await withModelControls(async (container) => {
      expect(modelLabel(container)).toBe('retired-model');
    }, {
      beforeMount: () => useConfigStore.setState({ currentModelId: 'retired-model' }),
    });
  });
});

describe('ModelControls recovered subtask restoration', () => {
  const subtaskFixture = (hydrated: boolean) => () => {
    useContextStore.setState({ hasHydrated: hydrated });
    useConfigStore.setState({ currentAgentName: 'builder', currentModelId: 'model' });
    directoryStore.setState((state) => ({
      session: state.session.map((session) => ({ ...session, parentID: 'ses_root' })),
      message: { [sessionID]: [userMessage('msg_child', { providerID: 'fixture', modelID: 'alternate' }, 'orchestrator')] },
      part: { msg_child: [textPart('msg_child') as Part] },
    }));
  };

  test('uses the directory-scoped child session and restores its exact send configuration', async () => {
    await withModelControls(async () => {
      const config = useConfigStore.getState();
      expect(config.currentModelId).toBe('alternate');
      expect(config.currentAgentName).toBe('orchestrator');
      const selection = useSelectionStore.getState();
      expect(selection.getSessionAgentSelection(sessionID)).toBe('orchestrator');
      expect(selection.getAgentModelForSession(sessionID, 'orchestrator')).toMatchObject({ providerId: 'fixture', modelId: 'alternate' });
    }, { beforeMount: subtaskFixture(true) });
  });

  test('waits for context hydration before restoring, then restores', async () => {
    await withModelControls(async () => {
      expect(useConfigStore.getState().currentModelId).toBe('model');
      expect(useConfigStore.getState().currentAgentName).toBe('builder');
      await act(async () => { useContextStore.setState({ hasHydrated: true }); });
      expect(useConfigStore.getState().currentModelId).toBe('alternate');
      expect(useConfigStore.getState().currentAgentName).toBe('orchestrator');
    }, { beforeMount: subtaskFixture(false) });
  });
});


describe('ModelControls composer alignment', () => {
  const classOf = (container: HostElement, token: string) => container.find((node) => (node.getAttribute('class') ?? '').includes(token))?.getAttribute('class') ?? '';
  const countOf = (container: HostElement, token: string) => {
    let count = 0;
    const visit = (node: HostElement) => {
      if ((node.getAttribute('class') ?? '').split(/\s+/).includes(token)) count += 1;
      for (const child of node.childNodes) if ('tagName' in child) visit(child as HostElement);
    };
    visit(container);
    return count;
  };
  const THINKING_LABEL = 'model-controls__variant-label truncate text-[10px] font-medium leading-[14px] -my-[2px] py-[2px]';
  const setDesktopShell = (enabled: boolean) => {
    const target = globalThis as unknown as { window?: { __TAURI__?: unknown } };
    if (enabled) target.window!.__TAURI__ = { core: { invoke() {} } };
    else if (target.window) delete target.window.__TAURI__;
  };

  test('bottom-aligns the shared thinking-label path without changing shell alignment', async () => {
    // Browser (non-shell) desktop layout.
    await withModelControls(async (container) => {
      expect(countOf(container, 'model-controls__variant-label')).toBe(1);
      const label = classOf(container, 'model-controls__variant-label');
      expect(label).toContain(THINKING_LABEL);
      expect(label).toContain('translate-y-[2px]');
      expect(classOf(container, 'model-controls__agent-label')).toContain('-translate-y-px');
    }, { isMobile: false });

    // Desktop shell nudges the thinking label further and leaves the agent label alone.
    await withModelControls(async (container) => {
      const label = classOf(container, 'model-controls__variant-label');
      expect(label).toContain(THINKING_LABEL);
      expect(label).toContain('translate-y-[3px]');
      expect(label).not.toContain('translate-y-[2px]');
      expect(classOf(container, 'model-controls__agent-label')).not.toContain('-translate-y-px');
    }, { isMobile: false, beforeMount: () => setDesktopShell(true) });
    setDesktopShell(false);

    // The mobile trigger renders the same single label through the shared path.
    await withModelControls(async (container) => {
      expect(countOf(container, 'model-controls__variant-label')).toBe(1);
      expect(classOf(container, 'model-controls__variant-label')).toContain(THINKING_LABEL);
    }, { isMobile: true });
  });

  test('retains the existing desktop trigger geometry', async () => {
    await withModelControls(async (container) => {
      expect(classOf(container, 'model-controls__model-trigger').split(/\s+/)).toContain('h-8');
    }, { isMobile: false });
    await withModelControls(async (container) => {
      expect(classOf(container, 'model-controls__model-trigger').split(/\s+/)).toContain('h-9');
    }, { isMobile: true });
  });
});

describe('ModelControls Cursor fast-only controls', () => {
  test('does not render visible Thinking headers or labels in variant controls', async () => {
    for (const panel of ['model', 'agent'] as const) {
      await withModelControls(async (container) => {
        expect(container.textContent).not.toContain('Thinking:');
        // Only the slider's accessible name mentions Thinking; no visible header or label.
        expect(container.find((node) => node.ownText.trim() === 'Thinking')).toBeNull();
        expect(container.find((node) => node.textContent.trim() === 'Thinking')).toBeNull();
      }, { panel });
    }
  });

  test('does not render compact price text in model picker rows', async () => {
    const priced = { ...baseModel, cost: { input: 1.5, output: 7.25, cache: { read: 0.1, write: 0.2 } } };
    await withModelControls(async (container) => {
      expect(container.textContent).toContain('Fixture Model');
      expect(container.textContent).not.toMatch(/\$|1\.5|7\.25/);
    }, {
      panel: 'model',
      beforeMount: () => useConfigStore.setState({
        providers: [{ id: 'fixture', name: 'Fixture', source: 'custom', options: {}, env: [], models: [priced, { ...priced, id: 'alternate', name: 'Alternate Model' }] }],
      }),
    });
  });

  test('keeps a rehydrated draft variant while the draft agent is still restoring', async () => {
    const draft = () => {
      useSessionUIStore.setState({ currentSessionId: null });
      useConfigStore.setState({ currentAgentName: undefined, currentVariant: 'low' } as never);
    };
    await withModelControls(async () => {
      expect(useConfigStore.getState().currentVariant).toBe('low');
    }, { beforeMount: draft });

    // An open session without an agent has nothing to preserve: the variant resets.
    await withModelControls(async () => {
      expect(useConfigStore.getState().currentVariant).toBeUndefined();
    }, { beforeMount: () => useConfigStore.setState({ currentAgentName: undefined, currentVariant: 'low' } as never) });
  });
});

describe('ModelControls picker thinking placement', () => {
  const triggerOf = (container: HostElement) => container.find((node) => (node.getAttribute('class') ?? '').includes('model-controls__model-trigger'))!;
  const thinkingCount = (container: HostElement) => {
    let count = 0;
    const visit = (node: HostElement) => {
      if ((node.getAttribute('class') ?? '').includes('model-controls__thinking ')) count += 1;
      for (const child of node.childNodes) if ('tagName' in child) visit(child as HostElement);
    };
    visit(container);
    return count;
  };

  test('the thinking level is part of the model trigger, not a second control', async () => {
    for (const isMobile of [true, false]) {
      await withModelControls(async (container) => {
        expect(thinkingCount(container)).toBe(1);
        expect(triggerOf(container).find((node) => (node.getAttribute('class') ?? '').includes('model-controls__thinking')))
          .not.toBeNull();
        // No standalone thinking popover trigger beside the model/agent triggers.
        expect(container.find((node) => node.getAttribute('aria-haspopup') === 'dialog'
          && (node.getAttribute('class') ?? '').includes('thinking'))).toBeNull();
      }, { isMobile, panel: null as never });
    }
  });

  test('selecting a mobile picker row applies the model and closes the panel', async () => {
    const panelChanges: unknown[] = [];
    await withModelControls(async (container) => {
      await act(async () => { button(container, 'Alternate Model')!.click(); });
      expect(useConfigStore.getState().currentModelId).toBe('alternate');
      expect(panelChanges).toEqual([null]);
    }, { panel: 'model', onPanelChange: (next) => { panelChanges.push(next); } });
  });
});
