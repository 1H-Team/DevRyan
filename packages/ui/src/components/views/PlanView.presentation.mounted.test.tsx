import React, { act } from 'react';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { SessionPlanRevisionIdentity, SessionPlansAPI } from '@/lib/api/types';
import type { SessionPlanFileRecord } from '@/stores/useSessionPlanFileStore';
import { withDom, type HostElement } from '@/test/mountedDom';

// PlanView keeps retained drafts per revision identity at module scope, so every test gets its own.
let sourceMessageId = 'message-plan';
let fixtureCount = 0;
const identity = (sessionId: string): SessionPlanRevisionIdentity => ({ sessionId, sourceMessageId, directory: '/repo', sessionCreated: 123, sessionSlug: 'plan' });
let currentSessionId = 'session-a';
let mobile = false;
let records: Record<string, SessionPlanFileRecord> = {};
let runtime: { sessionPlans: SessionPlansAPI; files: object };
let editor: { value: string; onChange: (content: string) => void };
const mainTabs: string[] = [];
const noop = () => {};
const t = (key: string) => key;
const comments = { drafts: [], commentText: '', editingDraftId: null, setSelection: noop, saveComment: noop, cancel: noop, reset: noop, startEdit: noop, deleteDraft: noop };

mock.module('@/sync/session-ui-store', () => ({ useSessionUIStore: (select: (state: { currentSessionId: string }) => unknown) => select({ currentSessionId }) }));
mock.module('@/sync/sync-context', () => ({ useSessions: () => [] }));
mock.module('@/stores/useSessionPlanFileStore', () => ({ useSessionPlanFileStore: Object.assign(
  (select: (state: { recordsBySession: typeof records }) => unknown) => select({ recordsBySession: records }),
  { getState: () => ({ markSaved: noop }) },
) }));
mock.module('@/stores/useDirectoryStore', () => ({ useDirectoryStore: (select: (state: { homeDirectory: string }) => unknown) => select({ homeDirectory: '/home/test' }) }));
mock.module('@/stores/useFeatureFlagsStore', () => ({ useFeatureFlagsStore: (select: (state: { planModeEnabled: boolean }) => unknown) => select({ planModeEnabled: true }) }));
mock.module('@/stores/useUIStore', () => ({ useUIStore: (select: (state: { setActiveMainTab: (tab: string) => void; setSessionSwitcherOpen: typeof noop }) => unknown) => select({ setActiveMainTab: (tab) => { mainTabs.push(tab); }, setSessionSwitcherOpen: noop }) }));
mock.module('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => runtime }));
mock.module('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: mobile }) }));
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t }) }));
mock.module('@/contexts/useThemeSystem', () => ({ useThemeSystem: () => ({ currentTheme: {} }) }));
mock.module('@/lib/theme/syntaxThemeGenerator', () => ({ generateSyntaxTheme: noop }));
mock.module('@/lib/codemirror/flexokiTheme', () => ({ createFlexokiCodeMirrorTheme: () => [] }));
mock.module('@/lib/codemirror/languageByExtension', () => ({ languageByExtension: () => null }));
mock.module('@/components/comments', () => ({ buildCodeMirrorCommentWidgets: () => [], normalizeLineRange: (value: unknown) => value, useInlineCommentController: () => comments }));
mock.module('@/components/ui/CodeMirrorEditor', () => ({ CodeMirrorEditor: (props: typeof editor) => { editor = props; return <div data-editor>{`[editor]${props.value}`}</div>; } }));
mock.module('@/components/chat/MarkdownRenderer', () => ({ SimpleMarkdownRenderer: ({ content }: { content: string }) => <div>{`[preview]${content}`}</div> }));
mock.module('@/components/ui/ScrollableOverlay', () => ({ ScrollableOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
mock.module('./PreviewToggleButton', () => ({ PreviewToggleButton: ({ onToggle, currentMode }: { onToggle: () => void; currentMode: string }) => <button onClick={onToggle}>{`toggle:${currentMode}`}</button> }));
mock.module('@/components/ui/button', () => ({ Button: ({ children, onClick, ...rest }: { children?: React.ReactNode; onClick?: () => void } & Record<string, unknown>) => (
  <button onClick={onClick} data-plan-view-close={rest['data-plan-view-close'] as string | undefined} aria-label={rest['aria-label'] as string | undefined}>{children}</button>
) }));

const { PlanView } = await import('./PlanView');

let reads = 0;
let readFailure: string | null = null;
let updateFailure: string | null = null;
const api: SessionPlansAPI = {
  ensureRevision: async (input) => ({ path: `/plans/${input.sessionId}.md`, created: false, version: 'v1' }),
  readRevision: async (input) => {
    reads += 1;
    if (readFailure) throw new Error(readFailure);
    return { path: `/plans/${input.sessionId}.md`, content: `# Plan ${input.sessionId}`, version: 'v1' };
  },
  updateRevision: async (input) => {
    if (updateFailure) throw new Error(updateFailure);
    return { path: `/plans/${input.sessionId}.md`, saved: true, version: 'v2' };
  },
};

beforeEach(() => {
  sourceMessageId = `message-plan-${++fixtureCount}`;
  currentSessionId = 'session-a'; mobile = false; mainTabs.length = 0; reads = 0; readFailure = null; updateFailure = null;
  records = Object.fromEntries(['session-a', 'session-b'].map((id) => [id, { sourceMessageId, path: `/plans/${id}.md`, revisionIdentity: identity(id), status: 'saved', error: null }])) as typeof records;
  runtime = { sessionPlans: api, files: {} };
});

const mountPlan = async (props: React.ComponentProps<typeof PlanView>, run: (container: HostElement, rerender: () => Promise<void>, flushSave: () => Promise<void>) => Promise<void>) => withDom(async (container) => {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  const timers: Array<() => void> = [];
  Object.assign(window, { setTimeout: (callback: () => void, delay: number) => { if (delay === 350) { timers.push(callback); return timers.length; } return setTimeout(callback, delay); } });
  try {
    await act(async () => { root.render(<PlanView {...props} />); });
    await act(async () => { await Promise.resolve(); });
    await run(
      container,
      async () => { await act(async () => { root.render(<PlanView {...props} />); }); },
      async () => { await act(async () => { const pending = timers.splice(0); pending.forEach((callback) => callback()); }); await act(async () => { await Promise.resolve(); }); },
    );
  } finally { await act(async () => { root.unmount(); }); }
});
const button = (container: HostElement, text: string) => container.find((node) => node.tagName === 'BUTTON' && node.textContent === text);

describe('plan presentation', () => {
  test('opens each plan as rendered Markdown while keeping editing temporary', async () => {
    await mountPlan({}, async (container, rerender) => {
      expect(container.textContent).toContain('[preview]# Plan session-a');
      expect(container.textContent).not.toContain('[editor]');
      await act(async () => button(container, 'toggle:preview')?.click());
      expect(container.textContent).toContain('[editor]# Plan session-a');
      expect(container.textContent).not.toContain('[preview]');
      currentSessionId = 'session-b';
      await rerender();
      await act(async () => { await Promise.resolve(); });
      expect(container.textContent).toContain('[preview]# Plan session-b');
      expect(container.textContent).not.toContain('[editor]');
    });
  });

  test('exposes a scoped read failure and re-reads on retry', async () => {
    readFailure = 'revision unavailable';
    await mountPlan({}, async (container) => {
      expect(container.textContent).toContain('planView.error.loadFailed');
      expect(container.textContent).toContain('revision unavailable');
      const before = reads;
      readFailure = null;
      await act(async () => { button(container, 'planView.actions.retryLoad')?.click(); await Promise.resolve(); });
      await act(async () => { await Promise.resolve(); });
      expect(reads).toBeGreaterThan(before);
      expect(container.textContent).toContain('[preview]# Plan session-a');
      expect(container.textContent).not.toContain('planView.error.loadFailed');
    });
  });

  test('uses the compact mobile header with Close before the action group, routing back to chat', async () => {
    mobile = true;
    await mountPlan({}, async (container) => {
      const text = container.textContent;
      expect(text).toContain('layout.mainTab.plan');
      expect(text).not.toContain('Plan session-a\n');
      const close = container.find((node) => node.getAttribute('data-plan-view-close') === 'true');
      const actions = container.find((node) => node.getAttribute('data-plan-view-actions') === 'true');
      expect(close).not.toBeNull();
      expect(actions).not.toBeNull();
      const order: HostElement[] = [];
      const walk = (node: HostElement) => { order.push(node); node.childNodes.forEach((child) => { if ('tagName' in child) walk(child as HostElement); }); };
      walk(container);
      expect(order.indexOf(close!)).toBeLessThan(order.indexOf(actions!));
      await act(async () => close!.click());
      expect(mainTabs).toEqual(['chat']);
    });
  });

  test('shows the plan title in the standalone header on desktop and no Close control', async () => {
    await mountPlan({}, async (container) => {
      expect(container.find((node) => node.getAttribute('data-plan-view-close') === 'true')).toBeNull();
      expect(container.find((node) => node.getAttribute('data-plan-view-actions') === 'true')).not.toBeNull();
    });
  });

  test('has no improve or implement actions in the plan viewer', async () => {
    await mountPlan({}, async (container) => {
      expect(container.textContent).not.toContain('planView.actions.improvePlanAria');
      expect(container.textContent).not.toContain('planView.actions.implementPlanAria');
      const actions = container.find((node) => node.getAttribute('data-plan-view-actions') === 'true')!;
      const labels = actions.childNodes.map((child) => ('getAttribute' in child ? (child as HostElement).getAttribute('aria-label') : null)).filter(Boolean);
      expect(labels).toEqual(['planView.actions.copyPlanContents']);
    });
  });

  test('keeps save failures visible whether or not the standalone title row is shown', async () => {
    updateFailure = 'disk is full';
    for (const presentation of ['standalone', 'context-panel'] as const) {
      await mountPlan({ presentation }, async (container, _rerender, flushSave) => {
        await act(async () => button(container, 'toggle:preview')?.click());
        await act(async () => { editor.onChange('# Edited'); });
        await flushSave();
        const alert = container.find((node) => node.getAttribute('role') === 'alert');
        expect(alert?.textContent).toContain('disk is full');
      });
    }
  });

  test('suppresses the standalone header controls in the context-panel presentation', async () => {
    mobile = true;
    await mountPlan({ presentation: 'context-panel' }, async (container) => {
      expect(container.textContent).not.toContain('layout.mainTab.plan');
      expect(container.find((node) => node.getAttribute('data-plan-view-close') === 'true')).toBeNull();
    });
  });
});
