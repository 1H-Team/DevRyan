import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Todo } from '@opencode-ai/sdk/v2/client';

import { withDom, type HostElement } from '@/components/bots/chat/botMountedDom';
import { useTodosPersistStore } from '@/stores/useTodosPersistStore';
import { useSessionPlanFileStore } from '@/stores/useSessionPlanFileStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

// Real StatusRow, stores and effects; only the directory sync read, the lazy
// plan loader and the effective-directory lookup sit behind mocks.
const syncModule = await import('@/sync/sync-context');
mock.module('@/sync/sync-context', () => ({
  ...syncModule,
  useDirectorySync: (selector: (state: { todo: Record<string, Todo[]> }) => unknown) => selector({ todo: {} }),
}));
let preloads = 0;
mock.module('@/components/views/planViewLoader', () => ({
  preloadPlanView: async () => { preloads += 1; },
}));
mock.module('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/fixture' }));

const { I18nProvider } = await import('@/lib/i18n');
const { TooltipProvider } = await import('@/components/ui/tooltip');
const { StatusRow } = await import('./StatusRow');

const SESSION = 'ses_status';
const todos: Todo[] = [
  { content: 'Write the audit', status: 'in_progress', priority: 'high' },
  { content: 'Ship it', status: 'pending', priority: 'medium' },
];

let setActiveMainTabCalls: string[] = [];
beforeEach(() => {
  preloads = 0;
  setActiveMainTabCalls = [];
  useUIStore.setState({ isMobile: false, setActiveMainTab: (tab: string) => { setActiveMainTabCalls.push(tab); } } as never);
  useSessionUIStore.setState({ currentSessionId: SESSION, sessionPlanAvailable: new Map(), sessionPlanIndicator: new Map() });
  useTodosPersistStore.setState({ sessions: { [SESSION]: { todos, touchedAt: 1 } } });
  useSessionPlanFileStore.setState({ recordsBySession: {} });
});
afterEach(() => {
  mock.restore();
});

type Props = React.ComponentProps<typeof StatusRow>;
const row = (props: Props) => (
  <I18nProvider><TooltipProvider><StatusRow {...props} /></TooltipProvider></I18nProvider>
);

const mountRow = async (
  initial: Props,
  run: (container: HostElement, update: (next: Props) => Promise<void>) => Promise<void>,
) => withDom(async (container) => {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(row(initial)));
    await run(container, (next) => act(async () => root.render(row(next))));
  } finally {
    await act(async () => root.unmount());
  }
});

const taskSummary = (container: HostElement) => container.find((node) => node.tagName === 'BUTTON' && (node.getAttribute('aria-label') ?? '').includes('Write the audit'));
const labelClass = (container: HostElement) => taskSummary(container)?.find((node) => node.tagName === 'SPAN')?.getAttribute('class') ?? '';
const tabList = (container: HostElement) => container.find((node) => (node.getAttribute('class') ?? '').includes('transition-[grid-template-rows]'));

describe('StatusRow tab task-label width', () => {
  test('widens the tucked-tab summary without colliding with Plan or changing the non-tab path', async () => {
    await mountRow({ tabBackground: '#222' }, async (container) => {
      const collapsed = labelClass(container);
      expect(collapsed).toContain('max-w-[min(69cqw,calc(100cqw-6.5rem))]');
      expect(collapsed).not.toContain('max-w-[60cqw]');
      expect(collapsed).not.toContain('status-row__active-todo');
      await act(async () => { taskSummary(container)!.click(); });
      expect(labelClass(container)).toContain('max-w-[calc(100cqw-2.25rem)]');
    });

    await mountRow({}, async (container) => {
      const label = labelClass(container);
      expect(label).toContain('status-row__active-todo max-w-[200px]');
      expect(label).not.toContain('max-w-[38cqw]');
    });

    useUIStore.setState({ isMobile: true } as never);
    await mountRow({}, async (container) => {
      expect(labelClass(container)).toContain('max-w-[38cqw]');
    });
    // The compact cap belongs to the non-tab path only.
    await mountRow({ tabBackground: '#222' }, async (container) => {
      expect(labelClass(container)).not.toContain('max-w-[38cqw]');
    });
  });
});

describe('StatusRow suppressTab', () => {
  test('hides the tucked tab without unmounting plan effects and collapses an expanded list', async () => {
    await mountRow({ tabBackground: '#222' }, async (container, update) => {
      expect(taskSummary(container)).not.toBeNull();
      await act(async () => { taskSummary(container)!.click(); });
      expect(tabList(container)?.getAttribute('class')).toContain('grid-rows-[1fr]');

      await update({ tabBackground: '#222', suppressTab: true });
      expect(taskSummary(container)).toBeNull();
      expect(tabList(container)).toBeNull();

      await update({ tabBackground: '#222', suppressTab: false });
      expect(tabList(container)?.getAttribute('class')).toContain('grid-rows-[0fr]');
    });
  });

  test('keeps auto-revealing a saved plan while the tab is suppressed', async () => {
    useUIStore.setState({ isMobile: true } as never);
    useSessionUIStore.setState({ sessionPlanAvailable: new Map([[SESSION, true]]) });
    useSessionPlanFileStore.setState({ recordsBySession: { [SESSION]: {
      status: 'saved', sourceMessageId: 'msg_plan', path: '/fixture/plan.md',
    } as never } });
    await mountRow({ tabBackground: '#222', suppressTab: true }, async (container) => {
      expect(taskSummary(container)).toBeNull();
      expect(setActiveMainTabCalls).toEqual(['plan']);
      expect(preloads).toBeGreaterThan(0);
    });
  });
});
