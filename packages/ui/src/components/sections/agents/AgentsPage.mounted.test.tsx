import React, { act } from 'react';
import { expect, mock, spyOn, test } from 'bun:test';
import { withDom, type HostElement } from '@/components/bots/chat/botMountedDom';
import type { AgentWithExtras } from '@/stores/useAgentsStore';

const passthrough = ({ children }: React.PropsWithChildren) => <>{children}</>;
for (const [path, names] of [
  ['collapsible', ['Collapsible', 'CollapsibleContent', 'CollapsibleTrigger']],
  ['tooltip', ['Tooltip', 'TooltipContent', 'TooltipTrigger']],
  ['select', ['Select', 'SelectContent', 'SelectItem', 'SelectSeparator', 'SelectTrigger', 'SelectValue']],
  ['ScrollableOverlay', ['ScrollableOverlay']],
] as const) {
  mock.module(`@/components/ui/${path}`, () => Object.fromEntries(names.map((name) => [name, passthrough])));
}
mock.module('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button onClick={onClick} disabled={disabled}>{children}</button>,
}));
mock.module('@/components/ui/input', () => ({ Input: () => null }));
mock.module('@/components/ui/number-input', () => ({ NumberInput: () => null }));
mock.module('@/components/ui/textarea', () => ({ Textarea: () => null }));
mock.module('@/components/ui/switch', () => ({ Switch: () => null }));
mock.module('@/components/ui', () => ({ toast: { success() {}, error() {}, warning() {} } }));
const t = (key: string) => key;
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t }) }));
mock.module('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: false }) }));
const permissions = {};
const actualSync = await import('@/sync/sync-context');
mock.module('@/sync/sync-context', () => ({ ...actualSync, useDirectorySync: () => permissions }));
mock.module('@/components/sections/behavior/BehaviorPage', () => ({ BehaviorPage: passthrough }));
mock.module('./AgentRuntimeSection', () => ({ AgentRuntimeSection: () => null }));
mock.module('./ModelSelector', () => ({
  ModelSelector: ({ providerId, modelId, onChange }: { providerId: string; modelId: string; onChange: (provider: string, model: string) => void }) => (
    <button data-model={`${providerId}/${modelId}`} onClick={() => onChange(providerId, `${modelId}-draft`)}>{modelId}</button>
  ),
}));
const { AgentsPage } = await import('./AgentsPage');
const { useAgentsStore } = await import('@/stores/useAgentsStore');
const { useConfigStore } = await import('@/stores/useConfigStore');
const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
const { opencodeClient } = await import('@/lib/opencode/client');
const { getAuthPrincipal, setAuthPrincipal } = await import('@/lib/authSession');

const modelButton = (container: HostElement, model: string) => {
  const button = container.find((node) => node.getAttribute('data-model') === `example/${model}`);
  expect(button).not.toBeNull();
  return button!;
};

for (const selected of ['builder', 'council']) {
  test(`${selected} drafts survive unrelated saved fields and provider refresh, and reset on selection changes`, async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    const originalAgents = useAgentsStore.getState();
    const originalConfig = useConfigStore.getState();
    const originalDirectory = useDirectoryStore.getState();
    const originalPrincipal = getAuthPrincipal();
    const tools = spyOn(opencodeClient, 'listToolIds').mockResolvedValue([]);
    const agent: AgentWithExtras = {
      name: selected, mode: 'all' as const, options: {}, permission: [],
      model: { providerID: 'example', modelID: 'primary' }, modelRefs: ['example/primary'],
      councillors: selected === 'council' ? [{ model: 'example/primary' }, { model: 'example/second' }] : undefined,
      backupModel: { providerID: 'example', modelID: 'backup', variant: null },
    };
    try {
      setAuthPrincipal({ ...originalPrincipal, scope: 'local-admin', role: 'admin' });
      useAgentsStore.setState({ agents: [agent, { ...agent, name: 'other' }], selectedAgentName: selected });
      useConfigStore.setState({ providers: [] });
      useDirectoryStore.setState({ currentDirectory: '/draft-fixture/a' });
      await act(async () => { root.render(<AgentsPage />); });
      await act(async () => { modelButton(container, 'primary').click(); });
      if (selected === 'council') await act(async () => { modelButton(container, 'second').click(); });
      // The same catalog replacement performed by a successful Backup save.
      await act(async () => {
        const saved: AgentWithExtras = { ...agent, backupModel: { providerID: 'example', modelID: 'saved-backup', variant: null } };
        useAgentsStore.setState({ agents: [saved] });
        useConfigStore.setState({ providers: [] });
      });
      modelButton(container, 'primary-draft');
      if (selected === 'council') modelButton(container, 'second-draft');
      else {
        await act(async () => { modelButton(container, 'saved-backup').click(); });
        // A Primary save must not reset the independently edited Backup row.
        await act(async () => {
          const saved: AgentWithExtras = { ...agent, model: { providerID: 'example', modelID: 'saved-primary' }, modelRefs: ['example/saved-primary'], backupModel: { providerID: 'example', modelID: 'saved-backup', variant: null } };
          useAgentsStore.setState({ agents: [saved] });
          useConfigStore.setState({ providers: [] });
        });
        modelButton(container, 'saved-backup-draft');
        modelButton(container, 'saved-primary');
      }
      await act(async () => {
        useAgentsStore.setState({ agents: [agent] });
        useDirectoryStore.setState({ currentDirectory: '/draft-fixture/b' });
      });
      modelButton(container, 'primary');
      if (selected === 'council') modelButton(container, 'second');
      else modelButton(container, 'backup');
      await act(async () => { modelButton(container, 'primary').click(); });
      await act(async () => { useAgentsStore.setState({ agents: [{ ...agent, name: 'other' }], selectedAgentName: 'other' }); });
      modelButton(container, 'primary');
    } finally {
      await act(async () => { root.unmount(); });
      tools.mockRestore();
      useAgentsStore.setState(originalAgents);
      useConfigStore.setState(originalConfig);
      useDirectoryStore.setState(originalDirectory);
      setAuthPrincipal(originalPrincipal);
    }
  }));
}
