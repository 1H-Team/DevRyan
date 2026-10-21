import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Agent } from '@opencode-ai/sdk/v2';

import { withDom } from '@/components/bots/chat/botMountedDom';
import { getAuthPrincipal, setAuthPrincipal, type AuthPrincipal } from '@/lib/authSession';
import { useAgentsStore } from '@/stores/useAgentsStore';
import { useUIStore } from '@/stores/useUIStore';
import {
  canViewAgentRuntime,
  resolveAgentsGlobalView,
  useAgentsSettingsEntries,
} from './useAgentsSettingsEntries';

const agent = (name: string, mode: Agent['mode']): Agent => ({ name, mode, options: {}, permission: [] });

const base = getAuthPrincipal();
const managed = (role: AuthPrincipal['role'], policy: Partial<AuthPrincipal['policy']> = {}): AuthPrincipal => ({
  ...base,
  scope: 'managed',
  role,
  policy: { ...base.policy, settingsPermissions: undefined, settingsPages: ['*'], ...policy },
});

const originalAgents = useAgentsStore.getState();
const originalUi = useUIStore.getState();
beforeEach(() => {
  useAgentsStore.setState({
    agents: [agent('builder', 'primary'), agent('fixer', 'subagent')],
    selectedAgentName: null,
    selectedGlobalView: 'behavior',
  });
});
afterEach(() => {
  useAgentsStore.setState(originalAgents, true);
  useUIStore.setState(originalUi, true);
  setAuthPrincipal(base);
});

type Entries = ReturnType<typeof useAgentsSettingsEntries>;
const readEntries = async (principal: AuthPrincipal): Promise<{ read: () => Entries }> => {
  setAuthPrincipal(principal);
  let latest: Entries | null = null;
  const Probe = () => { latest = useAgentsSettingsEntries(); return null; };
  const handle = { read: () => latest as Entries };
  await withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    try { await act(async () => { root.render(<Probe />); }); } finally { await act(async () => root.unmount()); }
  });
  return handle;
};

describe('Agents settings entries', () => {
  test('removes Global Behavior and falls back to an individual agent when hidden', async () => {
    const hidden = managed('developer', { featureOverrides: { agents: { hideGlobalBehaviorUi: true } } });
    const entries = await readEntries(hidden);
    expect(entries.read().general.map((entry) => entry.kind)).not.toContain('behavior');
    expect(useAgentsStore.getState().selectedAgentName).toBe('builder');

    useAgentsStore.setState({ selectedAgentName: null });
    const visible = await readEntries(managed('developer'));
    expect(visible.read().general.map((entry) => entry.kind)).toContain('behavior');
    expect(useAgentsStore.getState().selectedAgentName).toBeNull();
  });

  test('offers Runtime only to host editors', async () => {
    for (const [principal, expected] of [
      [{ ...base, scope: 'local-admin', role: 'admin' } as AuthPrincipal, true],
      [managed('admin'), true],
      [managed('developer'), false],
    ] as const) {
      const entries = await readEntries(principal);
      expect(canViewAgentRuntime(principal)).toBe(expected);
      expect(entries.read().general.some((entry) => entry.kind === 'runtime')).toBe(expected);
    }
  });

  test('falls a non-host-editor back from the runtime view to behavior', () => {
    expect(resolveAgentsGlobalView('runtime', managed('developer'))).toBe('behavior');
    expect(resolveAgentsGlobalView('runtime', managed('admin'))).toBe('runtime');
    expect(resolveAgentsGlobalView('behavior', managed('admin'))).toBe('behavior');
  });

  test('offers Session Defaults to anyone who may read sessions, and routes it to the sessions page', async () => {
    const noSessions = managed('developer', { settingsPages: ['agents'] });
    expect((await readEntries(noSessions)).read().general.map((entry) => entry.kind)).not.toContain('session-defaults');

    const entries = await readEntries(managed('developer', { settingsPages: ['agents', 'sessions'] }));
    const sessionDefaults = entries.read().general.find((entry) => entry.kind === 'session-defaults');
    expect(sessionDefaults).toBeDefined();
    useUIStore.setState({ settingsPage: 'agents' });
    entries.read().select(sessionDefaults!);
    expect(useUIStore.getState().settingsPage).toBe('sessions');
    const agentEntry = entries.read().primaryAgents[0];
    entries.read().select(agentEntry!);
    expect(useUIStore.getState().settingsPage).toBe('agents');
  });
});
