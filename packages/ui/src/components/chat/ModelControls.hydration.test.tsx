import React, { act } from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { useStore } from 'zustand';
import type { AssistantMessage, Model, Part, Session, TextPart, UserMessage } from '@opencode-ai/sdk/v2';
import { withDom, type HostElement } from '@/components/bots/chat/botMountedDom';
import { ChildStoreManager } from '@/sync/child-store';
import type { State } from '@/sync/types';

const directory = '/Users/zoubair/Repositories/DevRyan/.cache/qa/model-controls-hydration';
const sessionID = 'ses_choice_a';
const olderUserID = 'msg_choice_1';
const pendingUserID = 'msg_choice_2';
const manager = new ChildStoreManager();
const directoryStore = manager.ensureChild(directory, { bootstrap: false });

// Keep the real directory/config/selection stores and production selectors.
// Only the runtime-provider boundary and overlay/layout chrome are replaced;
// ModelControls' native buttons, React events and restoration effects run intact.
const syncModule = await import('@/sync/sync-context');
mock.module('@/sync/sync-context', () => ({
  ...syncModule,
  useDirectorySync: <T,>(selector: (state: State) => T) => useStore(directoryStore, selector),
  useSession: (id: string | null) => useStore(directoryStore, state => state.session.find(session => session.id === id)),
  useSessionMessages: (id: string) => useStore(directoryStore, state => state.message[id]),
  useSessionMessagesResolved: (id: string) => useStore(directoryStore, state => Object.hasOwn(state.message, id)),
}));
const sync = { isLoading: () => false, ensureSessionRenderable: async () => {} };
mock.module('@/sync/use-sync', () => ({ useSync: () => sync }));
const runtimeHooks = await import('@/hooks/useRuntimeAPIs');
mock.module('@/hooks/useRuntimeAPIs', () => ({ ...runtimeHooks }));
mock.module('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: true }) }));
mock.module('@/hooks/useOpenCodeReadiness', () => ({ useOpenCodeReadiness: () => ({ isReady: true, isUnavailable: false }) }));
mock.module('@/components/ui/ProviderLogo', () => ({ ProviderLogo: () => null }));
mock.module('@/components/ui/MobileOverlayPanel', () => ({
  MobileOverlayPanel: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <section>{children}</section> : null,
}));

const { useConfigStore } = await import('@/stores/useConfigStore');
const { useContextStore } = await import('@/stores/contextStore');
const { useUIStore } = await import('@/stores/useUIStore');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { useSelectionStore } = await import('@/sync/selection-store');
const { resolveCurrentSendConfig } = await import('@/sync/send-config');
const { optimisticSend, setActionRefs, setOptimisticRefs, clearActionRefs } = await import('@/sync/session-actions');
const { applyOptimisticAdd, applyOptimisticRemove } = await import('@/sync/optimistic');
const { opencodeClient } = await import('@/lib/opencode/client');
const { I18nProvider } = await import('@/lib/i18n');
const { AgentHandoffGuardContext } = await import('./agentHandoffGuardContext');
const { ModelControls } = await import('./ModelControls');
const handoffGuard = { requestAgentChange: async ({ commit }: { commit: () => void }) => { commit(); }, guardBuilderSend: async () => true };

const model: Model = {
  id: 'model', providerID: 'fixture', name: 'Fixture Model',
  api: { id: 'model', url: 'https://fixture.invalid', npm: 'fixture' },
  capabilities: {
    temperature: true, reasoning: true, attachment: false, toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 1000, output: 100 }, status: 'active',
  options: {}, headers: {}, release_date: '2026-01-01', variants: { low: {}, high: {} },
};

const user = (id: string, variant: string): UserMessage => ({
  id, sessionID, role: 'user', agent: 'builder', time: { created: id === olderUserID ? 1 : 2 },
  model: { providerID: 'fixture', modelID: 'model', variant },
});
const textPart = (messageID: string): TextPart => ({
  id: `prt_${messageID}`, sessionID, messageID, type: 'text', text: 'Repair the fixture.',
});
const planPart = (messageID: string): Part => ({
  ...textPart(messageID), type: 'text', synthetic: true,
  text: 'User has requested to enter plan mode.\nProduce an implementation plan only.',
});
const assistant = (id: string, parentID: string): AssistantMessage => ({
  id, parentID, sessionID, role: 'assistant', time: { created: 2, completed: 3 },
  modelID: 'model', providerID: 'fixture', mode: 'builder', agent: 'builder',
  path: { cwd: directory, root: directory }, cost: 0,
  tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
});

const prepare = () => {
  useSelectionStore.getState().clearSessionSelection(sessionID);
  useSelectionStore.getState().clearSessionSelection('ses_choice_b');
  useContextStore.setState({ hasHydrated: true });
  useConfigStore.setState({
    activeDirectoryKey: directory, directoryScoped: {},
    providers: [{ id: 'fixture', name: 'Fixture', source: 'custom', options: {}, env: [], models: [model, { ...model, id: 'alternate', name: 'Alternate Model', variants: {} }] }],
    agents: ['builder', 'orchestrator'].map(name => ({ name, mode: 'primary', model: { providerID: 'fixture', modelID: 'model' }, permission: [], options: {} })),
    currentProviderId: 'fixture', currentModelId: 'model', currentAgentName: 'builder', currentVariant: null,
    isInitialized: true, isConnected: true,
  });
  useUIStore.setState({ favoriteModels: [], hiddenModels: [], isModelSelectorOpen: false });
  useSessionUIStore.setState({ currentSessionId: sessionID, currentDraftId: null, planModeUserMessages: new Set(), newSessionDraft: { open: false, directoryOverride: null, parentID: null } });
  useSessionUIStore.getState().setSessionDirectory(sessionID, directory);
  const session: Session = {
    id: sessionID, slug: 'choice', projectID: 'fixture', directory, title: 'Choice', version: '1',
    time: { created: 1, updated: 2 },
  };
  directoryStore.setState({
    session: [session], message: { [sessionID]: [user(olderUserID, ''), user(pendingUserID, 'high')] },
    part: { [olderUserID]: [textPart(olderUserID)] }, session_status: { [sessionID]: { type: 'busy' } },
  });
  setActionRefs(opencodeClient.getSdkClient(), manager, () => directory);
  setOptimisticRefs(
    input => directoryStore.setState(state => {
      const draft = { message: { ...state.message, [input.sessionID]: [...(state.message[input.sessionID] ?? [])] }, part: { ...state.part } };
      applyOptimisticAdd(draft, input);
      return draft;
    }),
    input => directoryStore.setState(state => {
      const draft = { message: { ...state.message, [input.sessionID]: [...(state.message[input.sessionID] ?? [])] }, part: { ...state.part } };
      applyOptimisticRemove(draft, input);
      return draft;
    }),
  );
};

const variantTrigger = (container: HostElement) => {
  const trigger = container.find(node => node.getAttribute('class')?.includes('model-controls__variant-trigger') === true);
  expect(trigger).not.toBeNull();
  return trigger!;
};

const withControls = async (run: (container: HostElement, remount: (panel?: React.ComponentProps<typeof ModelControls>['mobilePanel']) => Promise<void>) => Promise<void>, beforeMount?: () => void) => withDom(async container => {
  const frameDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: () => 0 });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  prepare();
  beforeMount?.();
  let renderKey = 0;
  const remount = async (panel: React.ComponentProps<typeof ModelControls>['mobilePanel'] = 'variant') => { await act(async () => { root.render(<I18nProvider><AgentHandoffGuardContext value={handoffGuard}><ModelControls key={renderKey++} mobilePanel={panel} onMobilePanelChange={() => {}} /></AgentHandoffGuardContext></I18nProvider>); }); };
  try {
    await remount();
    await run(container, remount);
  } finally {
    await act(async () => { root.unmount(); });
    useSelectionStore.getState().clearSessionSelection(sessionID);
    useSelectionStore.getState().clearSessionSelection('ses_choice_b');
    clearActionRefs(manager);
    if (frameDescriptor) Object.defineProperty(globalThis, 'requestAnimationFrame', frameDescriptor);
    else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
  }
});

const deliverPendingParts = () => directoryStore.setState(state => ({
  part: { ...state.part, [pendingUserID]: [textPart(pendingUserID)] },
}));

const choose = async (container: HostElement, label: string) => {
  const button = container.find(node => node.tagName === 'BUTTON' && node.textContent === label);
  expect(button).not.toBeNull();
  await act(async () => { button!.click(); });
};

const currentChoice = () => {
  const choice = resolveCurrentSendConfig(sessionID);
  if (!choice.providerID || !choice.modelID) throw new Error('Fixture send choice is unavailable');
  return { ...choice, providerID: choice.providerID, modelID: choice.modelID };
};

const dispatch = (choice = currentChoice(), send: (messageID: string) => Promise<void> = async () => {}) => optimisticSend({
  ...choice, sessionId: sessionID, directory, content: 'Use my selected model and effort.', send,
});

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
};

const deliverNewCanonicalChoice = (variant: string) => directoryStore.setState(state => {
  const message: UserMessage = { ...user('msg_choice_later', variant), time: { created: Date.now() + 1000 } };
  return {
    message: { ...state.message, [sessionID]: [...(state.message[sessionID] ?? []), message] },
    part: { ...state.part, [message.id]: [textPart(message.id)] },
  };
});

describe('ModelControls delayed user-part hydration', () => {
  test('cold restore keeps human Plan through a managed wake and captures Plan on the next actual send', async () => withControls(async () => {
    let sentPlanMode: boolean | undefined;
    const captured = currentChoice();
    await act(async () => { await dispatch(captured, async () => { sentPlanMode = captured.planMode; }); });
    expect(sentPlanMode).toBe(true);
    const sentMessage = directoryStore.getState().message[sessionID]?.at(-1);
    expect(sentMessage?.role).toBe('user');
    expect(directoryStore.getState().part[sentMessage!.id]?.some(part => part.type === 'text' && part.synthetic === true && part.text.startsWith('User has requested to enter plan mode'))).toBe(true);
  }, () => {
    useSessionUIStore.setState({ planModeUserMessages: new Set([olderUserID]) });
    directoryStore.setState({
      message: { [sessionID]: [user(olderUserID, 'high'), assistant('msg_plan_response', olderUserID), user(pendingUserID, 'high')] },
      part: {
        [olderUserID]: [textPart(olderUserID), planPart(olderUserID)],
        msg_plan_response: [textPart('msg_plan_response')],
        [pendingUserID]: [{ ...textPart(pendingUserID), type: 'text', synthetic: true, text: '[devryan-provider-recovery:v1:task_fixture]\nCollect the completed managed result.' }],
      },
    });
  }));

  test('defers Plan restoration at newest user info without parts instead of choosing older non-Plan', async () => withControls(async () => {
    expect(useSelectionStore.getState().sessionPlanModeSelections.has(sessionID)).toBe(false);
    await act(async () => { directoryStore.setState(state => ({ part: { ...state.part, [pendingUserID]: [textPart(pendingUserID), planPart(pendingUserID)] } })); });
    expect(currentChoice().planMode).toBe(true);
  }));

  test('refines an older inferred OFF when later user info and then Plan parts arrive', async () => withControls(async () => {
    expect(currentChoice().planMode).toBe(false);
    await act(async () => { directoryStore.setState(state => ({ message: { ...state.message, [sessionID]: [...state.message[sessionID], user(pendingUserID, 'high')] } })); });
    await act(async () => { directoryStore.setState(state => ({ part: { ...state.part, [pendingUserID]: [textPart(pendingUserID), planPart(pendingUserID)] } })); });
    expect(currentChoice().planMode).toBe(true);
  }, () => directoryStore.setState({ message: { [sessionID]: [user(olderUserID, '')] } })));

  test('an explicit local OFF survives later Plan hydration and a mounted remount', async () => withControls(async (container, remount) => {
    await remount('agent');
    const toggle = () => container.find(node => node.tagName === 'BUTTON' && node.textContent === 'Plan');
    expect(toggle()).not.toBeNull();
    await act(async () => { toggle()!.click(); });
    expect(currentChoice().planMode).toBe(true);
    await act(async () => { toggle()!.click(); });
    expect(currentChoice().planMode).toBe(false);
    await act(async () => { directoryStore.setState(state => ({ part: { ...state.part, [pendingUserID]: [textPart(pendingUserID), planPart(pendingUserID)] } })); });
    await remount('agent');
    expect(currentChoice().planMode).toBe(false);
  }));

  test('preserves a newer unsent Low selection when older High user parts arrive', async () => withControls(async container => {
    expect(variantTrigger(container).textContent).toBe('Default');
    const low = container.find(node => node.tagName === 'BUTTON' && node.textContent === 'Low');
    expect(low).not.toBeNull();
    await act(async () => { low!.click(); });
    expect(variantTrigger(container).textContent).toBe('Low');
    expect(resolveCurrentSendConfig(sessionID).variant).toBe('low');

    await act(async () => { deliverPendingParts(); });

    expect(variantTrigger(container).textContent).toBe('Low');
    expect(resolveCurrentSendConfig(sessionID).variant).toBe('low');

    let sentVariant: string | null | undefined;
    const captured = currentChoice();
    await act(async () => { await dispatch(captured, async () => { sentVariant = captured.variant; }); });
    expect(sentVariant).toBe('low');
    expect(useSelectionStore.getState().getSessionModelSelectionIntent(sessionID)).toBeUndefined();

    await act(async () => { deliverNewCanonicalChoice('high'); });
    expect(variantTrigger(container).textContent).toBe('High');
    expect(currentChoice().variant).toBe('high');

  }));

  test('restores High on delayed user parts when no newer manual selection exists', async () => withControls(async container => {
    expect(variantTrigger(container).textContent).toBe('Default');

    await act(async () => { deliverPendingParts(); });

    expect(variantTrigger(container).textContent).toBe('High');
    expect(resolveCurrentSendConfig(sessionID).variant).toBe('high');
  }));

  test('preserves a manually selected model without variants until its matching send', async () => withControls(async (container, remount) => {
    await remount('model');
    const alternate = container.find(node => node.tagName === 'BUTTON' && node.textContent.startsWith('Alternate Model'));
    expect(alternate).not.toBeNull();
    await act(async () => { alternate!.click(); deliverPendingParts(); });
    expect(container.textContent).toContain('Alternate Model');
    expect(currentChoice().modelID).toBe('alternate');

    await act(async () => { await dispatch(); });
    expect(useSelectionStore.getState().getSessionModelSelectionIntent(sessionID)).toBeUndefined();
    await act(async () => { deliverNewCanonicalChoice('high'); });
    expect(currentChoice().modelID).toBe('model');
    expect(currentChoice().variant).toBe('high');
  }));

  test('keeps a later Low choice when an older queued High snapshot sends', async () => withControls(async container => {
    await choose(container, 'High');
    const queued = currentChoice();
    await choose(container, 'Low');
    const manualIntent = useSelectionStore.getState().getSessionModelSelectionIntent(sessionID);
    let sentVariant: string | null | undefined;

    await act(async () => {
      await dispatch(queued, async () => { sentVariant = queued.variant; });
      deliverPendingParts();
    });

    expect(sentVariant).toBe('high');
    expect(variantTrigger(container).textContent).toBe('Low');
    expect(currentChoice().variant).toBe('low');
    expect(useSelectionStore.getState().getSessionModelSelectionIntent(sessionID)).toBe(manualIntent);
  }));

  test('releases the manual guard after the user changes agent and sends the updated choice', async () => withControls(async (container, remount) => {
    await choose(container, 'Low');
    await remount('agent');
    const orchestrator = container.find(node => node.tagName === 'BUTTON' && node.textContent.startsWith('Orchestrator'));
    expect(orchestrator).not.toBeNull();
    await act(async () => { orchestrator!.click(); });
    expect(currentChoice().agent).toBe('orchestrator');
    await act(async () => { await dispatch(); });
    expect(useSelectionStore.getState().getSessionModelSelectionIntent(sessionID)).toBeUndefined();
  }));

  test('retains the manual choice after a failed matching send and rollback', async () => withControls(async container => {
    await choose(container, 'Low');
    const beforeMessages = directoryStore.getState().message[sessionID];
    await act(async () => {
      await expect(dispatch(currentChoice(), async () => { throw new Error('Fixture transport failed'); })).rejects.toThrow('Fixture transport failed');
      deliverPendingParts();
    });

    expect(directoryStore.getState().message[sessionID]).toEqual(beforeMessages);
    expect(variantTrigger(container).textContent).toBe('Low');
    expect(currentChoice().variant).toBe('low');
    expect(useSelectionStore.getState().getSessionModelSelectionIntent(sessionID)?.variant).toBe('low');
  }));

  test('does not consume a newer manual pick made during a matching send, even with the same final value', async () => withControls(async container => {
    await choose(container, 'Low');
    const captured = currentChoice();
    const transport = deferred();
    const started = deferred();
    let sending: Promise<void> | undefined;
    await act(async () => {
      sending = dispatch(captured, async () => { started.resolve(); await transport.promise; });
      await started.promise;
    });
    await choose(container, 'High');
    await choose(container, 'Low');
    const latestIntent = useSelectionStore.getState().getSessionModelSelectionIntent(sessionID);
    await act(async () => { transport.resolve(); await sending; deliverNewCanonicalChoice('high'); });

    expect(variantTrigger(container).textContent).toBe('Low');
    expect(currentChoice().variant).toBe('low');
    expect(useSelectionStore.getState().getSessionModelSelectionIntent(sessionID)).toBe(latestIntent);
  }));

  test('keeps unsent Default across a session switch, delayed hydration and a component remount', async () => withControls(async (container, remount) => {
    await choose(container, 'Low');
    await choose(container, 'Default');
    expect(currentChoice().variant).toBeNull();
    const secondSessionID = 'ses_choice_b';
    const secondUser: UserMessage = { ...user('msg_second_session', 'high'), sessionID: secondSessionID };
    useSessionUIStore.getState().setSessionDirectory(secondSessionID, directory);
    await act(async () => {
      directoryStore.setState(state => ({
        session: [...state.session, { ...state.session[0]!, id: secondSessionID }],
        message: { ...state.message, [secondSessionID]: [secondUser] },
        part: { ...state.part, [secondUser.id]: [{ ...textPart(secondUser.id), sessionID: secondSessionID }] },
      }));
      useSessionUIStore.setState({ currentSessionId: secondSessionID });
    });
    expect(variantTrigger(container).textContent).toBe('High');

    await act(async () => { deliverPendingParts(); useSessionUIStore.setState({ currentSessionId: sessionID }); });
    await remount();
    expect(variantTrigger(container).textContent).toBe('Default');
    expect(currentChoice().variant).toBeNull();

    await act(async () => { await dispatch(); });
    expect(useSelectionStore.getState().getSessionModelSelectionIntent(sessionID)).toBeUndefined();
    await act(async () => { deliverNewCanonicalChoice('high'); });
    expect(variantTrigger(container).textContent).toBe('High');
  }));
});
