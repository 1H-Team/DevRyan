import React, { act } from 'react';
import { describe, expect, mock, test } from 'bun:test';
import type { SessionPlanRevisionIdentity, SessionPlansAPI } from '@/lib/api/types';
import type { SessionPlanFileRecord } from '@/stores/useSessionPlanFileStore';
import { withDom } from '@/components/bots/chat/botMountedDom';
import { notifyPlanUpdated } from '@/lib/sessionEvents';

let fixtureCount = 0;
let sourceMessageId = 'message-plan';
const identity = (sessionId = 'session-a'): SessionPlanRevisionIdentity => ({ sessionId, sourceMessageId, directory: '/repo', sessionCreated: 123, sessionSlug: 'plan' });
const pathFor = (input: SessionPlanRevisionIdentity) => `/plans/${input.sessionId}.md`;
let currentSessionId = 'session-a';
let fixtureSessions: Array<{ id: string; directory: string; slug: string; time: { created: number } }> = [];
let records: Record<string, SessionPlanFileRecord> = {};
let runtime: { sessionPlans: SessionPlansAPI; files: object };
let editor: { value: string; onChange: (content: string) => void };
const noop = () => {};
const t = (key: string) => key;
const comments = { drafts: [], commentText: '', editingDraftId: null, setSelection: noop, saveComment: noop, cancel: noop, reset: noop, startEdit: noop, deleteDraft: noop };

mock.module('@/sync/session-ui-store', () => ({ useSessionUIStore: (select: (state: { currentSessionId: string }) => unknown) => select({ currentSessionId }) }));
mock.module('@/sync/sync-context', () => ({ useSessions: () => fixtureSessions }));
mock.module('@/stores/useSessionPlanFileStore', () => ({ useSessionPlanFileStore: (select: (state: { recordsBySession: typeof records }) => unknown) => select({ recordsBySession: records }) }));
mock.module('@/stores/useDirectoryStore', () => ({ useDirectoryStore: (select: (state: { homeDirectory: string }) => unknown) => select({ homeDirectory: '/home/test' }) }));
mock.module('@/stores/useFeatureFlagsStore', () => ({ useFeatureFlagsStore: (select: (state: { planModeEnabled: boolean }) => unknown) => select({ planModeEnabled: true }) }));
mock.module('@/stores/useUIStore', () => ({ useUIStore: (select: (state: { setActiveMainTab: typeof noop; setSessionSwitcherOpen: typeof noop }) => unknown) => select({ setActiveMainTab: noop, setSessionSwitcherOpen: noop }) }));
mock.module('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => runtime }));
mock.module('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: false }) }));
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t }) }));
mock.module('@/contexts/useThemeSystem', () => ({ useThemeSystem: () => ({ currentTheme: {} }) }));
mock.module('@/lib/theme/syntaxThemeGenerator', () => ({ generateSyntaxTheme: noop }));
mock.module('@/lib/codemirror/flexokiTheme', () => ({ createFlexokiCodeMirrorTheme: () => [] }));
mock.module('@/lib/codemirror/languageByExtension', () => ({ languageByExtension: () => null }));
mock.module('@/components/comments', () => ({ buildCodeMirrorCommentWidgets: () => [], normalizeLineRange: (value: unknown) => value, useInlineCommentController: () => comments }));
mock.module('@/components/ui/CodeMirrorEditor', () => ({ CodeMirrorEditor: (props: typeof editor) => { editor = props; return <div>{props.value}</div>; } }));
mock.module('@/components/chat/MarkdownRenderer', () => ({ SimpleMarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }));
mock.module('@/components/ui/ScrollableOverlay', () => ({ ScrollableOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
mock.module('./PreviewToggleButton', () => ({ PreviewToggleButton: ({ onToggle }: { onToggle: () => void }) => <button onClick={onToggle}>Edit</button> }));
mock.module('@/components/ui/button', () => ({ Button: ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => <button onClick={onClick}>{children}</button> }));

const { PlanView } = await import('./PlanView');
const updateEvent = (input: SessionPlanRevisionIdentity, version: string) => notifyPlanUpdated({
  sessionID: input.sessionId, sourceMessageID: input.sourceMessageId, directory: input.directory,
  sessionCreated: input.sessionCreated, sessionSlug: input.sessionSlug, version,
});

const fixture = async (run: (view: { edit: (content: string) => Promise<void>; save: () => Promise<void>; switchTo: (session: string) => Promise<void>; remount: () => Promise<void>; text: () => string }) => Promise<void>, api: SessionPlansAPI, options: { legacySession?: boolean; files?: object } = {}) => withDom(async container => {
  currentSessionId = 'session-a';
  sourceMessageId = `message-plan-${++fixtureCount}`;
  records = Object.fromEntries(['session-a', 'session-b'].map(id => [id, { sourceMessageId, path: pathFor(identity(id)), revisionIdentity: identity(id), status: 'saved', error: null }]));
  fixtureSessions = options.legacySession ? [{ id: 'session-a', directory: '/repo-a', slug: 'legacy', time: { created: 123 } }] : [];
  if (options.legacySession) delete records['session-a'];
  runtime = { sessionPlans: api, files: options.files ?? {} };
  const timers = new Map<number, () => void>();
  let id = 1000000;
  const realTimeout = window.setTimeout;
  const realClear = window.clearTimeout;
  Object.assign(window, {
    setTimeout: (callback: () => void, delay: number) => {
      if (delay !== 350) return realTimeout(callback, delay);
      const next = ++id; timers.set(next, callback); return next;
    },
    clearTimeout: (timer: number) => { if (!timers.delete(timer)) realClear(timer); },
  });
  const { createRoot } = await import('react-dom/client');
  let root = createRoot(container as unknown as Element);
  const render = () => root.render(<PlanView />);
  const openEditor = async () => {
    if (container.find(node => node.tagName === 'BUTTON' && node.textContent === 'Edit')) {
      await act(async () => { container.find(node => node.tagName === 'BUTTON' && node.textContent === 'Edit')!.click(); });
    }
  };
  try {
    await act(async () => { render(); });
    await openEditor();
    await run({
      edit: async content => { await act(async () => { editor.onChange(content); }); },
      save: async () => { await act(async () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); }); },
      switchTo: async session => { currentSessionId = session; await act(async () => { render(); }); await openEditor(); },
      remount: async () => { await act(async () => { root.unmount(); }); root = createRoot(container as unknown as Element); await act(async () => { render(); }); await openEditor(); },
      text: () => container.textContent,
    });
  } finally { await act(async () => { root.unmount(); }); }
});

describe('mounted plan revision ownership', () => {
  test('ignores a canceled legacy read rejection before activating its fallback after a session switch', async () => {
    let rejectRepo: (failure: Error) => void = () => {};
    let fallbackReads = 0;
    let genericWrites = 0;
    const writes: Array<{ sessionId: string; markdown: string; expectedVersion: string }> = [];
    const api: SessionPlansAPI = {
      ensureRevision: async input => ({ path: pathFor(input), created: false, version: 'v1' }),
      readRevision: async input => ({ path: pathFor(input), content: '# Current B', version: 'v1' }),
      updateRevision: async input => { writes.push(input); return { path: pathFor(input), saved: true, version: 'v2' }; },
    };
    await fixture(async view => {
      await view.switchTo('session-b');
      expect(view.text()).toContain('# Current B');
      await act(async () => { rejectRepo(new Error('legacy file missing')); });
      expect(view.text()).toContain('# Current B');
      expect(fallbackReads).toBe(0);
      await view.edit('# Edited B'); await view.save();
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({ sessionId: 'session-b', markdown: '# Edited B', expectedVersion: 'v1' });
      expect(genericWrites).toBe(0);
    }, api, { legacySession: true, files: {
      readFile: async (path: string) => {
        if (path.startsWith('/repo-a/')) return new Promise((_resolve, reject) => { rejectRepo = reject; });
        fallbackReads++;
        return { content: '# Late legacy A' };
      },
      writeFile: async () => { genericWrites++; return { success: true }; },
    } });
  });

  test('serializes latest edits, ignores own ack events and retains drafts while switching identities', async () => {
    const writes: Array<{ sessionId: string; markdown: string; expectedVersion: string }> = [];
    const releases: Array<(result: { path: string; saved: boolean; version: string }) => void> = [];
    const api: SessionPlansAPI = {
      ensureRevision: async input => ({ path: pathFor(input), created: false, version: 'v1' }),
      readRevision: async input => ({ path: pathFor(input), content: `# ${input.sessionId}`, version: 'v1' }),
      updateRevision: input => { writes.push(input); return new Promise(resolve => releases.push(resolve)); },
    };
    await fixture(async view => {
      await view.save();
      expect(writes).toHaveLength(0);
      await view.edit('# First'); await view.save();
      await view.edit('# Latest'); await view.save();
      expect(writes).toHaveLength(1);
      await act(async () => { updateEvent(identity(), 'v2'); releases[0]({ path: pathFor(identity()), saved: true, version: 'v2' }); });
      expect(writes).toHaveLength(2);
      expect(writes[1]).toMatchObject({ markdown: '# Latest', expectedVersion: 'v2' });
      await view.switchTo('session-b');
      expect(view.text()).toContain('# session-b');
      await view.switchTo('session-a');
      expect(view.text()).toContain('# Latest');
      await act(async () => { releases[1]({ path: pathFor(identity()), saved: true, version: 'v3' }); });
      expect(view.text()).not.toContain('draft is preserved');
    }, api);
  });

  test('refreshes only matching clean revisions and preserves dirty drafts on external changes', async () => {
    let markdown = '# Original';
    let version = 'v1';
    let reads = 0;
    const api: SessionPlansAPI = {
      ensureRevision: async input => ({ path: pathFor(input), created: false, version }),
      readRevision: async input => { reads++; return { path: pathFor(input), content: markdown, version }; },
      updateRevision: async input => ({ path: pathFor(input), saved: true, version: 'v4' }),
    };
    await fixture(async view => {
      expect(view.text()).toContain('# Original');
      await act(async () => { updateEvent({ ...identity(), directory: '/other' }, 'v2'); });
      expect(reads).toBe(1);
      markdown = '# External'; version = 'v2';
      await act(async () => { updateEvent(identity(), version); });
      expect(reads).toBe(2);
      expect(view.text()).toContain('# External');
      await view.edit('# My draft');
      await act(async () => { updateEvent(identity(), 'v3'); });
      expect(reads).toBe(2);
      expect(view.text()).toContain('# My draft');
      expect(view.text()).toContain('The saved plan changed. Your draft is preserved');
      markdown = '# New external revision'; version = 'v3';
      await view.remount();
      await act(async () => { updateEvent(identity(), 'v3'); });
      expect(reads).toBe(2);
      expect(view.text()).toContain('# My draft');
      expect(view.text()).not.toContain('# New external revision');
    }, api);
  });

  test('keeps a stale HTTP response visible without adopting its version or retrying a retained draft', async () => {
    let writes = 0;
    const api: SessionPlansAPI = {
      ensureRevision: async input => ({ path: pathFor(input), created: false, version: 'v1' }),
      readRevision: async input => ({ path: pathFor(input), content: '# Original', version: 'v1' }),
      updateRevision: async () => {
        writes++;
        throw Object.assign(new Error('The plan changed'), { status: 409, code: 'plan_version_conflict', version: 'v2' });
      },
    };
    await fixture(async view => {
      await view.edit('# My draft'); await view.save();
      expect(view.text()).toContain('# My draft');
      expect(view.text()).toContain('The saved plan changed. Your draft is preserved');
      await view.edit('# Edited after conflict'); await view.save();
      expect(writes).toBe(1);
      expect(view.text()).toContain('# Edited after conflict');
    }, api);
  });
});
