import React, { act } from 'react';
import { expect, mock, spyOn, test } from 'bun:test';
import { withDom, type HostElement } from '@/components/bots/chat/botMountedDom';
import type { AgentRuntimeSettings } from '@/stores/useAgentsStore';

const t = (key: string) => key;
const errors: string[] = [];
let restart: () => Promise<void> = async () => {};
const apis = { settings: { restartOpenCode: () => restart() } };
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t }) }));
mock.module('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => apis }));
mock.module('@/components/ui', () => ({ toast: { success() {}, error: (message: string) => errors.push(message) } }));
mock.module('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button onClick={onClick} disabled={disabled}>{children}</button>,
}));
mock.module('@/components/ui/switch', () => ({
  Switch: ({ checked, disabled, onCheckedChange }: { checked: boolean; disabled: boolean; onCheckedChange: (value: boolean) => void }) => (
    <button role="switch" aria-checked={checked} disabled={disabled} onClick={() => onCheckedChange(!checked)} />
  ),
}));
const { AgentRuntimeSection } = await import('./AgentRuntimeSection');
const { useAgentsStore } = await import('@/stores/useAgentsStore');
const { useConfigApplyStore } = await import('@/stores/useConfigApplyStore');
const restartButton = (container: HostElement) => container.find((node) => node.tagName === 'BUTTON'
  && node.textContent === 'settings.agents.runtime.actions.restart');

test('queued and failed restart requests retain the notice until the host reports a successful launch', async () => withDom(async (container) => {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  const original = useAgentsStore.getState();
  const originalApply = useConfigApplyStore.getState();
  let current: AgentRuntimeSettings = { lsp: false, appliesOnRestart: true, runtimeMode: 'managed', appliedLsp: true, restartRequired: true };
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(current));
  errors.length = 0;
  try {
    useAgentsStore.setState({ agentRuntimeSettings: null, isSavingAgentRuntimeSettings: false });
    restart = async () => {};
    await act(async () => root.render(<AgentRuntimeSection canEdit />));
    expect(restartButton(container)).not.toBeNull();
    await act(async () => restartButton(container)!.click());
    expect(restartButton(container)).not.toBeNull();
    expect(useAgentsStore.getState().agentRuntimeSettings?.restartRequired).toBe(true);
    restart = async () => { throw new Error('restart failed'); };
    await act(async () => restartButton(container)!.click());
    expect(restartButton(container)).not.toBeNull();
    expect(errors).toContain('restart failed');
    // A configuration event is only a refresh trigger. The GET proves application.
    current = { ...current, appliedLsp: false, restartRequired: false };
    await act(async () => useConfigApplyStore.setState({ status: {
      revision: 9, appliedRevision: 9, state: 'clean', pending: false, scopes: [], reasonCodes: [],
      activeSessionCount: 0, runtimeMode: 'managed', canApplyWhenIdle: false, canForceRestart: false,
    } }));
    expect(restartButton(container)).toBeNull();
    expect(useAgentsStore.getState().agentRuntimeSettings).toEqual(current);
  } finally {
    await act(async () => root.unmount());
    fetchMock.mockRestore();
    useAgentsStore.setState(original);
    useConfigApplyStore.setState(originalApply);
  }
}));

for (const runtimeMode of ['external', 'unknown'] as const) {
  test(`${runtimeMode} applied settings remain unknown after renderer remount and expose no restart action`, async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    const original = useAgentsStore.getState();
    const current: AgentRuntimeSettings = { lsp: false, appliesOnRestart: true, runtimeMode, appliedLsp: null, restartRequired: null };
    const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(current));
    try {
      useAgentsStore.setState({ agentRuntimeSettings: null, isSavingAgentRuntimeSettings: false });
      await act(async () => root.render(<AgentRuntimeSection canEdit />));
      expect(container.textContent).toContain(`settings.agents.runtime.${runtimeMode}.note`);
      expect(restartButton(container)).toBeNull();
      await act(async () => root.render(null));
      useAgentsStore.setState({ agentRuntimeSettings: null });
      await act(async () => root.render(<AgentRuntimeSection canEdit />));
      expect(useAgentsStore.getState().agentRuntimeSettings).toEqual(current);
      expect(container.textContent).toContain(`settings.agents.runtime.${runtimeMode}.note`);
      expect(restartButton(container)).toBeNull();
    } finally {
      await act(async () => root.unmount());
      fetchMock.mockRestore();
      useAgentsStore.setState(original);
    }
  }));
}
