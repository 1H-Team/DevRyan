import React, { act } from 'react';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { create } from 'zustand';
import { withDom } from '@/components/bots/chat/botMountedDom';
import { getAuthPrincipal, setAuthPrincipal } from '@/lib/authSession';
import type { SettingsDataBoundaryProps } from './SettingsDataBoundary';

const calls: string[] = [];
const admin = getAuthPrincipal();
const projects = create(() => ({ activeProjectId: 'fixture-project' }));
mock.module('@/stores/useProjectsStore', () => ({ useProjectsStore: projects }));
mock.module('@/stores/useUIStore', () => ({ useUIStore: { getState: () => ({ setSettingsPage: (page: string) => calls.push(`page:${page}`) }) } }));
for (const [store, actions] of Object.entries({
  useAgentsStore: ['setSelectedAgent', 'loadAgents'], useCommandsStore: ['loadCommands'],
  useMcpConfigStore: ['loadMcpConfigs'], useSkillsStore: ['loadSkills'],
  useSkillsCatalogStore: ['loadCatalog'], usePluginsStore: ['loadPlugins', 'loadSlimStatus'],
})) {
  mock.module(`@/stores/${store}`, () => ({ [store]: { getState: () => Object.fromEntries(
    actions.map(action => [action, () => { calls.push(action); return Promise.resolve(); }]),
  ) } }));
}
const { SettingsDataBoundary } = await import('./SettingsDataBoundary');
const { ManagedSettingsDataBoundary } = await import('./ManagedSettingsDataBoundary');
const importCalls = [...calls];

beforeEach(() => { setAuthPrincipal(admin); calls.length = 0; });
afterEach(() => setAuthPrincipal(admin));
const mounted = async (run: (render: (Component: React.FC<SettingsDataBoundaryProps>, props: SettingsDataBoundaryProps) => Promise<void>) => Promise<void>) => {
  await withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    try {
      await run(async (Component, props) => { await act(async () => root.render(<Component {...props}><span>Settings content</span></Component>)); });
    } finally { await act(async () => root.unmount()); }
  });
};

test('imports do not fetch data; mounting activates only the requested stores', async () => {
  expect(importCalls).toEqual([]);
  await mounted(async (render) => {
    await render(SettingsDataBoundary, { slug: 'plugins' });
    expect(calls).toEqual(['loadPlugins', 'loadSlimStatus']);
    await render(SettingsDataBoundary, { slug: 'plugins' });
    expect(calls).toEqual(['loadPlugins', 'loadSlimStatus']);
  });
});

test('normalizing the Behavior alias clears selection without fetching Agents twice', async () => {
  await mounted(async (render) => {
    await render(SettingsDataBoundary, { slug: 'agents', resetSelectedAgent: true });
    expect(calls).toEqual(['setSelectedAgent', 'page:agents', 'loadAgents']);
    await render(SettingsDataBoundary, { slug: 'agents', resetSelectedAgent: false });
    expect(calls).toEqual(['setSelectedAgent', 'page:agents', 'loadAgents']);
  });
});

test('managed effects require current page permission and never run administrator actions', async () => {
  setAuthPrincipal({ ...admin, scope: 'managed', role: 'developer',
    policy: { ...admin.policy, settingsPermissions: undefined, settingsPages: ['plugins'] } });
  await mounted(async (render) => {
    await render(ManagedSettingsDataBoundary, { slug: 'skills.installed' });
    expect(calls).toEqual([]);
    await render(ManagedSettingsDataBoundary, { slug: 'plugins' });
    expect(calls).toEqual(['loadPlugins', 'loadSlimStatus']);
  });
});
