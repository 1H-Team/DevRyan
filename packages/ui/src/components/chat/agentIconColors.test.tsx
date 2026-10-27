import React, { act } from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { createStore } from 'zustand/vanilla';
import { formatManagedTaskDisplayName } from '@devryan/orchestration-runtime';

import { withDom, type HostElement } from '@/test/mountedDom';
import { getAgentColor, getAgentIconColor } from '@/lib/agentColors';
import { I18nProvider } from '@/lib/i18n';
import { formatAgentLabel } from './mobileControlsUtils';
import {
  sessionID,
  useSelectionStore,
  withModelControls,
} from './modelControlsTestHarness';

// ManagedTaskList reads titles through the directory store.
const titles = createStore(() => ({ session: [] as Array<{ id: string; title: string }> }));
const syncModule = await import('@/sync/sync-context');
mock.module('@/sync/sync-context', () => ({
  ...syncModule,
  useDirectoryStore: () => titles,
  useSessionStatus: () => undefined,
  useSyncResyncSession: () => async () => undefined,
  setActiveSession: () => undefined,
}));
const { ManagedTaskList } = await import('./ManagedTaskList');
const { MobileAgentButton } = await import('./MobileAgentButton');

const PLAN_COLOR = 'var(--plan-mode-icon-color)';
const colorOf = (node: HostElement | null | undefined) => (node?.style as unknown as { color?: string } | undefined)?.color;
const iconColor = (name: string) => `var(${getAgentIconColor(name).var})`;
const glyphs = (root: HostElement) => {
  const found: HostElement[] = [];
  const visit = (node: HostElement) => {
    if (node.tagName === 'SVG' && colorOf(node)) found.push(node);
    for (const child of node.childNodes) if ('tagName' in child) visit(child as HostElement);
  };
  visit(root);
  return found;
};
const rowFor = (container: HostElement, label: string) => container.find((node) => node.tagName === 'BUTTON'
  && (node.getAttribute('class') ?? '').includes('rounded-xl') && node.textContent.startsWith(label));
const planToggle = (container: HostElement) => container.find((node) => node.tagName === 'BUTTON' && node.textContent === 'Plan')!;

describe('agent glyph color wiring', () => {
  test('uses fixed role colors only for agent glyphs', async () => {
    await withModelControls(async (container) => {
      // Trigger glyph and each agent row carry the fixed role color as an inline
      // style, never as a color class.
      const trigger = container.find((node) => (node.getAttribute('class') ?? '').includes('model-controls__agent-trigger'))!;
      const triggerGlyph = trigger.find((node) => node.tagName === 'SVG')!;
      expect(colorOf(triggerGlyph)).toBe(iconColor('builder'));

      for (const name of ['Builder', 'Orchestrator']) {
        const glyph = rowFor(container, name)!.find((node) => node.tagName === 'SVG')!;
        expect(colorOf(glyph)).toBe(iconColor(name.toLowerCase()));
        expect(glyph.getAttribute('class')).toBe('remixicon h-4 w-4 flex-shrink-0');
      }
      // The selected agent's label keeps the agent (not icon) color.
      const selectedLabel = rowFor(container, 'Builder')!.find((node) => node.tagName === 'SPAN' && node.textContent === 'Builder')!;
      expect(colorOf(selectedLabel)).toBe(`var(${getAgentColor('builder').var})`);
    }, { panel: 'agent' });

    const task = (agent: string) => ({
      partId: `p_${agent}`, taskId: `dvr_task_${agent}`, dispatchCallId: `c_${agent}`, agent, label: `${agent}-job`,
      status: 'running' as const, childSessionId: `ses_${agent}`, directory: '/workspace',
    });
    const tasks = [task('explorer'), task('designer')];
    titles.setState({ session: tasks.map((entry) => ({ id: entry.childSessionId, title: formatManagedTaskDisplayName(entry.label) })) });
    await withDom(async (container) => {
      const { createRoot } = await import('react-dom/client');
      const root = createRoot(container as unknown as Element);
      try {
        await act(async () => root.render(
          <I18nProvider><ManagedTaskList taskIds={tasks.map((entry) => entry.taskId)} fallbackTasks={tasks} /></I18nProvider>,
        ));
        for (const agent of ['explorer', 'designer']) {
          const group = container.find((node) => node.tagName === 'SECTION' && node.getAttribute('aria-label') === formatAgentLabel(agent))!;
          expect(colorOf(group.find((node) => node.tagName === 'SVG'))).toBe(iconColor(agent));
        }
      } finally {
        await act(async () => root.unmount());
      }
    });
  });

  test('keeps every active plan-mode glyph on its fixed yellow override', async () => {
    await withModelControls(async (container, remount) => {
      expect(colorOf(planToggle(container).find((node) => node.tagName === 'SVG'))).toBeUndefined();
      await act(async () => { planToggle(container).click(); });
      await remount('agent');
      expect(useSelectionStore.getState().getSessionPlanMode(sessionID)).toBe(true);
      const trigger = container.find((node) => (node.getAttribute('class') ?? '').includes('model-controls__agent-trigger'))!;
      expect(colorOf(trigger.find((node) => node.tagName === 'SVG'))).toBe(PLAN_COLOR);
      expect(colorOf(planToggle(container).find((node) => node.tagName === 'SVG'))).toBe(PLAN_COLOR);
      // Agent rows keep their own fixed role color.
      expect(colorOf(rowFor(container, 'Orchestrator')!.find((node) => node.tagName === 'SVG'))).toBe(iconColor('orchestrator'));
    }, { panel: 'agent' });

    const planned = () => useSelectionStore.getState().setSessionPlanMode(sessionID, true);
    await withModelControls(async (container) => {
      const [agentGlyph, planGlyph] = glyphs(container);
      expect(colorOf(agentGlyph)).toBe(PLAN_COLOR);
      expect(colorOf(planGlyph)).toBe(PLAN_COLOR);
    }, { subject: <MobileAgentButton onOpenAgentPanel={() => undefined} />, beforeMount: planned });

    await withModelControls(async (container) => {
      const [agentGlyph, ...rest] = glyphs(container);
      expect(colorOf(agentGlyph)).toBe(iconColor('builder'));
      expect(rest).toHaveLength(0);
    }, { subject: <MobileAgentButton onOpenAgentPanel={() => undefined} /> });
  });
});
