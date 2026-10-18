import React, { act } from 'react';
import { expect, mock, spyOn, test } from 'bun:test';
import { withDom, type HostElement } from '@/components/bots/chat/botMountedDom';
import type { AgentWithExtras } from '@/stores/useAgentsStore';
import type { Model } from '@opencode-ai/sdk/v2';

const passthrough = ({ children }: React.PropsWithChildren) => <>{children}</>;
for (const [path, names] of [
  ['collapsible', ['Collapsible', 'CollapsibleContent', 'CollapsibleTrigger']],
  ['tooltip', ['Tooltip', 'TooltipContent', 'TooltipTrigger']],
  ['ScrollableOverlay', ['ScrollableOverlay']],
] as const) {
  mock.module(`@/components/ui/${path}`, () => Object.fromEntries(names.map((name) => [name, passthrough])));
}
mock.module('@/components/ui/select', () => ({
  Select: ({ children, value, onValueChange, disabled }: React.PropsWithChildren<{ value: string; onValueChange: (value: string) => void; disabled: boolean }>) => (
    <div data-variant-select={value}>
      <button disabled={disabled} data-effort="default" onClick={() => onValueChange('__no_variant__')}>Choose provider default</button>
      <button disabled={disabled} data-effort="medium" onClick={() => onValueChange('medium')}>Choose medium</button>
      <button disabled={disabled} data-effort="high" onClick={() => onValueChange('high')}>Choose high</button>
      {children}
    </div>
  ),
  SelectContent: passthrough, SelectItem: passthrough, SelectSeparator: passthrough,
  SelectTrigger: passthrough, SelectValue: passthrough,
}));
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

const catalogModel = (id: string, variants: Model['variants']): Model => ({
  id, providerID: 'example', api: { id, url: 'https://example.test', npm: 'example' }, name: id,
  capabilities: { temperature: true, reasoning: true, attachment: false, toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false }, interleaved: false },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } }, limit: { context: 1000, output: 1000 },
  status: 'active', options: {}, headers: {}, release_date: '2026-01-01', variants,
});

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


for (const selected of ['builder', 'council']) {
  test(`${selected} retains saved efforts and blocks primary, backup and Council saves while catalog is unavailable`, async () => withDom(async container => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    const originalAgents = useAgentsStore.getState(), originalConfig = useConfigStore.getState();
    const originalDirectory = useDirectoryStore.getState(), originalPrincipal = getAuthPrincipal();
    const tools = spyOn(opencodeClient, 'listToolIds').mockResolvedValue([]);
    const saves: unknown[] = [], backups: unknown[] = [];
    const agent: AgentWithExtras = { name: selected, mode: 'all', options: {}, permission: [],
      model: { providerID: 'cursor-acp', modelID: 'composer-2.5' }, variant: 'high', modelRefs: ['cursor-acp/composer-2.5'],
      councillors: selected === 'council' ? [{ model: 'cursor-acp/composer-2.5', variant: 'high' }, { model: 'example/second', variant: 'ultra' }] : undefined,
      backupModel: { providerID: 'cursor-acp', modelID: 'composer-2.5', variant: 'high' },
    };
    try {
      setAuthPrincipal({ ...originalPrincipal, scope: 'local-admin', role: 'admin' });
      useAgentsStore.setState({ agents: [agent], selectedAgentName: selected,
        saveAgentModelOverride: async (name, config) => { saves.push({ name, config }); return null; },
        saveAgentBackupModel: async (name, config) => { backups.push({ name, config }); return null; },
      });
      useConfigStore.setState({ providers: [] });
      useDirectoryStore.setState({ currentDirectory: '/saved-availability-fixture' });
      await act(async () => { root.render(<AgentsPage />); });
      await act(async () => { useConfigStore.setState({ providers: [] }); });
      expect(container.textContent).toContain('Saved selection: high.');
      const save = container.find(node => node.tagName === 'BUTTON' && node.textContent.includes('settings.agents.page.actions.saveModelOverride'));
      expect(save).not.toBeNull();
      await act(async () => { save!.click(); });
      expect(saves).toEqual([]);
      expect(container.textContent).toContain('Refresh the model catalog or choose an available model before saving.');
      if (selected === 'builder') {
        const saveBackup = container.find(node => node.tagName === 'BUTTON' && node.textContent.includes('settings.agents.page.actions.saveBackupModel'));
        expect(saveBackup).not.toBeNull();
        await act(async () => { saveBackup!.click(); });
        expect(backups).toEqual([]);
      }
    } finally {
      await act(async () => { root.unmount(); }); tools.mockRestore();
      useAgentsStore.setState(originalAgents); useConfigStore.setState(originalConfig);
      useDirectoryStore.setState(originalDirectory); setAuthPrincipal(originalPrincipal);
    }
  }));
}

test('a cleared or variant-less backup does not show the primary variant', async () => withDom(async container => {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  const originalAgents = useAgentsStore.getState(), originalConfig = useConfigStore.getState();
  const originalDirectory = useDirectoryStore.getState(), originalPrincipal = getAuthPrincipal();
  const tools = spyOn(opencodeClient, 'listToolIds').mockResolvedValue([]);
  const agent: AgentWithExtras = { name: 'builder', mode: 'all', options: {}, permission: [],
    model: { providerID: 'cursor-acp', modelID: 'composer-2.5' }, variant: 'high', modelRefs: ['cursor-acp/composer-2.5'],
    backupModel: { providerID: 'cursor-acp', modelID: 'composer-2.5', variant: 'high' },
  };
  // Only the primary row may carry the saved High warning once the backup has none.
  const savedHighCount = () => container.textContent.split('Saved selection: high.').length - 1;
  try {
    setAuthPrincipal({ ...originalPrincipal, scope: 'local-admin', role: 'admin' });
    useAgentsStore.setState({ agents: [agent], selectedAgentName: 'builder',
      resetAgentBackupModel: async (name) => {
        const cleared: AgentWithExtras = { ...agent, name, backupModel: null };
        useAgentsStore.setState({ agents: [cleared] });
        return null;
      },
    });
    useConfigStore.setState({ providers: [] });
    useDirectoryStore.setState({ currentDirectory: '/cleared-backup-fixture' });
    await act(async () => { root.render(<AgentsPage />); });
    expect(savedHighCount()).toBe(2);

    const clear = container.find(node => node.tagName === 'BUTTON' && node.textContent.includes('settings.agents.page.actions.clearBackupModel'));
    expect(clear).not.toBeNull();
    await act(async () => { clear!.click(); });
    expect(savedHighCount()).toBe(1);

    await act(async () => {
      const variantless: AgentWithExtras = { ...agent, backupModel: { providerID: 'cursor-acp', modelID: 'composer-2.5', variant: null } };
      useAgentsStore.setState({ agents: [variantless] });
    });
    expect(savedHighCount()).toBe(1);
  } finally {
    await act(async () => { root.unmount(); }); tools.mockRestore();
    useAgentsStore.setState(originalAgents); useConfigStore.setState(originalConfig);
    useDirectoryStore.setState(originalDirectory); setAuthPrincipal(originalPrincipal);
  }
}));

for (const selected of ['builder', 'council']) {
  test(`${selected} requires an explicit supported effort or provider default and rechecks model changes`, async () => withDom(async container => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    const originalAgents = useAgentsStore.getState(), originalConfig = useConfigStore.getState();
    const originalDirectory = useDirectoryStore.getState(), originalPrincipal = getAuthPrincipal();
    const tools = spyOn(opencodeClient, 'listToolIds').mockResolvedValue([]);
    const saves: unknown[] = [], backups: unknown[] = [];
    const agent: AgentWithExtras = { name: selected, mode: 'all', options: {}, permission: [],
      model: { providerID: 'example', modelID: 'primary' }, modelRefs: ['example/primary'], variant: 'high',
      councillors: selected === 'council' ? [{ model: 'example/primary', variant: 'high' }, { model: 'example/second', variant: 'ultra' }] : undefined,
      backupModel: { providerID: 'example', modelID: 'backup', variant: 'ultra' },
    };
    const variantRows = () => {
      const rows: HostElement[] = [];
      container.find(node => { if (node.hasAttribute('data-variant-select')) rows.push(node); return false; });
      return rows;
    };
    const choose = async (index: number, effort: string) => {
      const option = variantRows()[index]?.find(node => node.getAttribute('data-effort') === effort);
      expect(option).not.toBeNull();
      await act(async () => { option!.click(); });
    };
    const saveButton = () => container.find(node => node.tagName === 'BUTTON' && node.textContent.includes('settings.agents.page.actions.saveModelOverride'))!;
    try {
      setAuthPrincipal({ ...originalPrincipal, scope: 'local-admin', role: 'admin' });
      useAgentsStore.setState({ agents: [agent], selectedAgentName: selected,
        saveAgentModelOverride: async (name, config) => { saves.push({ name, config }); return null; },
        saveAgentBackupModel: async (name, config) => { backups.push({ name, config }); return null; },
      });
      useConfigStore.setState({ providers: [{ id: 'example', name: 'Example', source: 'custom', options: {}, env: [],
        models: [catalogModel('primary', { medium: {} }), catalogModel('primary-draft', { high: {} }),
          catalogModel('second', { medium: {} }), catalogModel('backup', { medium: {} })],
      }] });
      useDirectoryStore.setState({ currentDirectory: '/invalid-effort-fixture' });
      await act(async () => { root.render(<AgentsPage />); });
      expect(container.textContent).toContain('Saved selection: high.');
      expect(container.textContent).toContain('Choose a supported thinking level or Provider default before saving.');
      expect(saveButton().hasAttribute('disabled')).toBe(true);
      await act(async () => { saveButton().click(); });
      expect(saves).toEqual([]);

      await choose(0, 'medium');
      if (selected === 'council') {
        expect(saveButton().hasAttribute('disabled')).toBe(true);
        await choose(1, 'default');
      }
      expect(saveButton().hasAttribute('disabled')).toBe(false);
      await act(async () => { saveButton().click(); });
      expect(saves).toEqual([{ name: selected, config: { name: selected, model: 'example/primary', variant: 'medium',
        councillors: selected === 'council' ? [{ model: 'example/primary', variant: 'medium' }, { model: 'example/second', variant: undefined }] : undefined,
      } }]);
      if (selected === 'builder') {
        await choose(1, 'default');
        const saveBackup = container.find(node => node.tagName === 'BUTTON' && node.textContent.includes('settings.agents.page.actions.saveBackupModel'))!;
        await act(async () => { saveBackup.click(); });
        expect(backups).toEqual([{ name: selected, config: { model: 'example/backup', variant: null } }]);
      }

      await act(async () => { modelButton(container, 'primary').click(); });
      expect(variantRows()[0]?.getAttribute('data-variant-select')).toBe('medium');
      expect(saveButton().hasAttribute('disabled')).toBe(true);
      await choose(0, 'default');
      expect(saveButton().hasAttribute('disabled')).toBe(false);
      await act(async () => { saveButton().click(); });
      expect(saves.at(-1)).toEqual({ name: selected, config: { name: selected, model: 'example/primary-draft', variant: undefined,
        councillors: selected === 'council' ? [{ model: 'example/primary-draft', variant: undefined }, { model: 'example/second', variant: undefined }] : undefined,
      } });
    } finally {
      await act(async () => { root.unmount(); }); tools.mockRestore();
      useAgentsStore.setState(originalAgents); useConfigStore.setState(originalConfig);
      useDirectoryStore.setState(originalDirectory); setAuthPrincipal(originalPrincipal);
    }
  }));
}
