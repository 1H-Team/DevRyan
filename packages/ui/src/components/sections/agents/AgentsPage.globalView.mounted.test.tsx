import React, { act } from 'react';
import { afterEach, expect, mock, test } from 'bun:test';

import { withDom } from '@/components/bots/chat/botMountedDom';
import { getAuthPrincipal, setAuthPrincipal, type AuthPrincipal } from '@/lib/authSession';

const passthrough = ({ children }: React.PropsWithChildren) => <>{children}</>;
mock.module('./AgentRuntimePage', () => ({ AgentRuntimePage: () => <span>[runtime-page]</span> }));
mock.module('@/components/sections/behavior/BehaviorPage', () => ({ BehaviorPage: () => <span>[behavior-page]</span> }));
mock.module('./ModelSelector', () => ({ ModelSelector: () => null }));
mock.module('@/components/ui', () => ({ toast: { success() {}, error() {}, warning() {} } }));
mock.module('@/components/ui/ScrollableOverlay', () => ({ ScrollableOverlay: passthrough }));
const t = (key: string) => key;
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t }) }));
const actualSync = await import('@/sync/sync-context');
mock.module('@/sync/sync-context', () => ({ ...actualSync, useDirectorySync: () => ({}) }));

const { AgentsPage } = await import('./AgentsPage');
const { useAgentsStore } = await import('@/stores/useAgentsStore');

const base = getAuthPrincipal();
const originalAgents = useAgentsStore.getState();
afterEach(() => { useAgentsStore.setState(originalAgents, true); setAuthPrincipal(base); });

const render = async (principal: AuthPrincipal, view: 'runtime' | 'behavior'): Promise<string> => {
  setAuthPrincipal(principal);
  useAgentsStore.setState({ agents: [], selectedAgentName: null, selectedGlobalView: view });
  let text = '';
  await withDom(async (container) => {
    Object.assign(globalThis.window, { location: { search: '' } });
    Object.assign(globalThis.document.documentElement, { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } });
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => { root.render(<AgentsPage />); });
      text = container.textContent;
    } finally { await act(async () => root.unmount()); }
  });
  return text;
};

test('has its own host-editor Runtime view outside any agent editor', async () => {
  const text = await render({ ...base, scope: 'local-admin', role: 'admin' }, 'runtime');
  expect(text).toContain('[runtime-page]');
  expect(text).not.toContain('settings.agents.page.section.identityRole');
});

test('does not show Runtime to a managed developer, who gets Behavior instead', async () => {
  const text = await render({ ...base, scope: 'managed', role: 'developer' }, 'runtime');
  expect(text).not.toContain('[runtime-page]');
});

test('renders nothing for the global view when Global Behavior is hidden for the principal', async () => {
  const hidden: AuthPrincipal = {
    ...base, scope: 'managed', role: 'developer',
    policy: { ...base.policy, settingsPermissions: undefined, settingsPages: ['*'], featureOverrides: { agents: { hideGlobalBehaviorUi: true } } },
  };
  const text = await render(hidden, 'behavior');
  expect(text).not.toContain('[behavior-page]');
  expect(text).not.toContain('[runtime-page]');
});
