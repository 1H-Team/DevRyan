// Test-only harness: the real ModelControls with real config/selection/session
// stores, behind a minimal runtime boundary. Production code never imports it.
import React, { act } from 'react';
import { mock } from 'bun:test';
import { useStore } from 'zustand';
import type { Model } from '@opencode-ai/sdk/v2';
import { withDom, type HostElement } from '@/components/bots/chat/botMountedDom';
import { ChildStoreManager } from '@/sync/child-store';
import type { State } from '@/sync/types';

export const directory = '/fixture/model-controls-harness';
export const sessionID = 'ses_harness';
const manager = new ChildStoreManager();
export const directoryStore = manager.ensureChild(directory, { bootstrap: false });

export const device = { isMobile: true };

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
mock.module('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: device.isMobile }) }));
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
const { I18nProvider } = await import('@/lib/i18n');
const { AgentHandoffGuardContext } = await import('./agentHandoffGuardContext');
const { ModelControls } = await import('./ModelControls');
export { useConfigStore, useContextStore, useUIStore, useSessionUIStore, useSelectionStore };

const handoffGuard = { requestAgentChange: async ({ commit }: { commit: () => void }) => { commit(); }, guardBuilderSend: async () => true };

export const baseModel: Model = {
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
  options: {}, headers: {}, release_date: '2026-01-01', variants: { low: {}, medium: {}, high: {} },
};

export const agentNames = ['builder', 'orchestrator'] as const;

export const prepareModelControls = () => {
  useSelectionStore.getState().clearSessionSelection(sessionID);
  useContextStore.setState({ hasHydrated: true });
  useConfigStore.setState({
    activeDirectoryKey: directory, directoryScoped: {},
    providers: [{ id: 'fixture', name: 'Fixture', source: 'custom', options: {}, env: [], models: [baseModel, { ...baseModel, id: 'alternate', name: 'Alternate Model', variants: {} }] }],
    agents: agentNames.map(name => ({ name, mode: 'primary', model: { providerID: 'fixture', modelID: 'model' }, permission: [], options: {} })),
    currentProviderId: 'fixture', currentModelId: 'model', currentAgentName: 'builder', currentVariant: null,
    isInitialized: true, isConnected: true, providersLoadStatus: 'ready',
  });
  useUIStore.setState({ favoriteModels: [], hiddenModels: [], isModelSelectorOpen: false });
  useSessionUIStore.setState({ currentSessionId: sessionID, currentDraftId: null, planModeUserMessages: new Set(), newSessionDraft: { open: false, directoryOverride: null, parentID: null } });
  useSessionUIStore.getState().setSessionDirectory(sessionID, directory);
  directoryStore.setState({
    session: [{ id: sessionID, slug: 'harness', projectID: 'fixture', directory, title: 'Harness', version: '1', time: { created: 1, updated: 2 } }],
    message: {}, part: {}, session_status: { [sessionID]: { type: 'idle' } },
  });
};

type Panel = React.ComponentProps<typeof ModelControls>['mobilePanel'];
const element = (panel: Panel, key = 0, onPanelChange: (next: Panel) => void = () => {}) => (
  <I18nProvider>
    <AgentHandoffGuardContext value={handoffGuard}>
      <ModelControls key={key} mobilePanel={panel} onMobilePanelChange={onPanelChange} />
    </AgentHandoffGuardContext>
  </I18nProvider>
);

/** Mount the real controls in the host DOM; `remount` replays restoration effects. */
export const withModelControls = async (
  run: (container: HostElement, remount: (panel?: Panel) => Promise<void>) => Promise<void>,
  options: { isMobile?: boolean; panel?: Panel; beforeMount?: () => void; subject?: React.ReactNode; onPanelChange?: (next: Panel) => void } = {},
) => withDom(async container => {
  const frameDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: () => 0 });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  device.isMobile = options.isMobile ?? true;
  prepareModelControls();
  options.beforeMount?.();
  let renderKey = 0;
  const remount = async (panel: Panel = options.panel ?? 'model') => { await act(async () => { root.render(options.subject ? <I18nProvider>{options.subject}</I18nProvider> : element(panel, renderKey++, options.onPanelChange)); }); };
  try {
    await remount();
    await run(container, remount);
  } finally {
    await act(async () => { root.unmount(); });
    useSelectionStore.getState().clearSessionSelection(sessionID);
    device.isMobile = true;
    if (frameDescriptor) Object.defineProperty(globalThis, 'requestAnimationFrame', frameDescriptor);
    else Reflect.deleteProperty(globalThis, 'requestAnimationFrame');
  }
});
