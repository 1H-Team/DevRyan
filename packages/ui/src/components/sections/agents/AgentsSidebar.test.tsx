import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Agent } from '@opencode-ai/sdk/v2';

import { withDom, type HostElement } from '@/components/bots/chat/botMountedDom';
import { I18nProvider } from '@/lib/i18n';
import { getAgentIconColor } from '@/lib/agentColors';
import { getAuthPrincipal, setAuthPrincipal } from '@/lib/authSession';
import { useAgentsStore } from '@/stores/useAgentsStore';
import { AgentsSidebar } from './AgentsSidebar';

const agent = (name: string, mode: Agent['mode']): Agent => ({ name, mode, options: {}, permission: [] });

const originalAgents = useAgentsStore.getState();
const originalPrincipal = getAuthPrincipal();
beforeEach(() => {
  setAuthPrincipal({ ...originalPrincipal, scope: 'local-admin', role: 'admin' });
  useAgentsStore.setState({
    agents: [agent('builder', 'primary'), agent('fixer', 'subagent'), agent('mystery-helper', 'all')],
    selectedAgentName: null,
    loadAgents: async () => true,
  });
});
afterEach(() => {
  useAgentsStore.setState(originalAgents, true);
  setAuthPrincipal(originalPrincipal);
});

const mount = async (run: (container: HostElement) => Promise<void>) => withDom(async (container) => {
  const { createRoot } = await import('react-dom/client');
  Object.assign(globalThis.window, { location: { search: '' } });
  Object.assign(globalThis.document.documentElement, { classList: { add() {}, remove() {}, toggle() {}, contains: () => false } });
  const root = createRoot(container as unknown as Element);
  try {
    await act(async () => { root.render(<I18nProvider><AgentsSidebar /></I18nProvider>); });
    await run(container);
  } finally { await act(async () => root.unmount()); }
});

/** Descendants in document order. */
const walk = (node: HostElement): HostElement[] => [
  node,
  ...node.childNodes.flatMap((child) => ('childNodes' in child && 'tagName' in child ? walk(child as HostElement) : [])),
];

/** The row button for an agent: its first svg (icon) and the element that carries the title. */
const row = (container: HostElement, title: string) => {
  const button = container.find((node) => node.tagName === 'BUTTON' && node.textContent === title);
  expect(button).not.toBeNull();
  const nodes = walk(button!);
  const icon = nodes.find((node) => node.tagName === 'SVG');
  const titleNode = nodes.find((node) => node.tagName === 'SPAN' && node.textContent === title);
  expect(icon).toBeDefined();
  expect(titleNode).toBeDefined();
  return { icon: icon!, order: { icon: nodes.indexOf(icon!), title: nodes.indexOf(titleNode!) } };
};

describe('AgentsSidebar agent icons', () => {
  test('renders the icon to the left of the agent name', async () => {
    await mount(async (container) => {
      const { order } = row(container, 'Builder');
      expect(order.icon).toBeLessThan(order.title);
    });
  });

  test("tints each icon with that agent's own color", async () => {
    await mount(async (container) => {
      expect((row(container, 'Builder').icon.style as { color?: string }).color).toBe(`var(${getAgentIconColor('builder').var})`);
      expect((row(container, 'Fixer').icon.style as { color?: string }).color).toBe(`var(${getAgentIconColor('fixer').var})`);
      expect(getAgentIconColor('builder').var).not.toBe(getAgentIconColor('fixer').var);
    });
  });

  test('no longer varies the icon by agent mode', async () => {
    await mount(async (container) => {
      const glyph = (title: string) => walk(row(container, title).icon).find((node) => node.tagName === 'PATH')?.getAttribute('d');
      expect(glyph('Builder')).toBeTruthy();
      // Primary, subagent and "all" agents draw the same glyph.
      expect(glyph('Fixer')).toBe(glyph('Builder'));
      expect(glyph('Mystery Helper')).toBe(glyph('Builder'));
    });
  });
});
