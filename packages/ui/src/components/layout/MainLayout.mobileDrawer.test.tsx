import React, { act } from 'react';
import { expect, mock, test } from 'bun:test';
import type { MotionValue } from 'motion/react';
import { withDom, type HostElement } from '@/components/bots/chat/botMountedDom';
import { useOptionalDrawer, type DrawerContextValue } from '@/contexts/DrawerContext';

// Keep real layout reconciliation, Zustand actions and project-draft dispatch.
// Heavy feature leaves, drag libraries and animation timing are outside this
// state-coordination test; physical placement is covered by the mobile QA cell.
const passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
const empty = () => null;
let device = { isMobile: true, isTablet: false, screenWidth: 390 };
let drawer: DrawerContextValue | null = null;
type DragInfo = { offset: { x: number }; velocity: { x: number } };
let leftDragEnd: ((event: unknown, info: DragInfo) => void) | undefined;
const drafts: Array<{ directoryOverride?: string | null }> = [];
const project = { id: 'qa-project', label: 'QA workspace', normalizedPath: '/qa/workspace' };
let activeProject: string | null = 'another-project';
mock.module('@/lib/device', () => ({ useDeviceInfo: () => device }));
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
mock.module('@/lib/authSession', () => ({
  useAuthPrincipal: () => ({ scope: 'managed', role: 'member' }),
  getAuthPrincipal: () => ({ scope: 'managed', role: 'member' }),
  hasAuthCapability: () => false,
  canReadSettingsPage: () => false,
}));
mock.module('@/lib/utils', () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(' '), formatPathForDisplay: (path: string) => path, isMacOS: () => false }));
mock.module('@/lib/desktop', () => ({ isDesktopShell: () => false, isTauriShell: () => false }));
mock.module('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/qa/workspace' }));
mock.module('@/stores/useUpdateStore', () => ({ useUpdateStore: () => empty }));
mock.module('@/stores/useBotsStore', () => ({ useBotsStore: () => null }));
mock.module('@/stores/useMainSidebarAudienceStore', () => ({ useMainSidebarAudienceStore: () => false }));
mock.module('motion/react', () => ({
  AnimatePresence: passthrough,
  useMotionValue: (initial: number) => {
    const [value] = React.useState(() => {
      let current = initial;
      return { get: () => current, set: (next: number) => { current = next; }, stop: empty };
    });
    return value;
  },
  useDragControls: () => ({ start: empty }),
  animate: (value: MotionValue<number>, target: number) => { value.set(target); return { stop: empty }; },
  motion: {
    button: ({ animate, children, onClick, ...props }: { animate: { pointerEvents: 'auto' | 'none' }; children?: React.ReactNode; onClick?: React.MouseEventHandler; 'aria-label'?: string }) =>
      <button aria-label={props['aria-label']} style={{ pointerEvents: animate.pointerEvents }} onClick={onClick}>{children}</button>,
    aside: ({ children, ...props }: { children?: React.ReactNode; 'aria-hidden'?: boolean; className?: string; onDragEnd?: (event: unknown, info: DragInfo) => void }) => {
      if (props.className?.includes('fixed left-0')) leftDragEnd = props.onDragEnd;
      return <aside aria-hidden={props['aria-hidden']}>{children}</aside>;
    },
  },
}));
mock.module('@dnd-kit/core', () => ({ DndContext: passthrough, DragOverlay: passthrough, KeyboardSensor: empty, PointerSensor: empty, closestCenter: empty, useSensor: empty, useSensors: empty }));
mock.module('@dnd-kit/sortable', () => ({ SortableContext: passthrough, arrayMove: empty, sortableKeyboardCoordinates: empty, verticalListSortingStrategy: empty }));
mock.module('@/components/ui/ScrollableOverlay', () => ({ ScrollableOverlay: passthrough }));
mock.module('@/components/session/sidebar/SessionSidebarMotionRow', () => ({ SessionSidebarMotionRow: passthrough }));
mock.module('@/components/session/sidebar/sortableItems', () => ({
  SortableProjectItem: ({ children, projectLabel, onNewSession }: { children?: React.ReactNode; projectLabel: string; onNewSession: () => void }) =>
    <section data-project-header={projectLabel}><button aria-label="New Draft Session" onClick={onNewSession} />{children}</section>,
  SortableGroupItem: passthrough,
}));
mock.module('./Header', () => ({ Header: ({ onToggleLeftDrawer, leftDrawerOpen, onToggleRightDrawer }: { onToggleLeftDrawer?: () => void; leftDrawerOpen?: boolean; onToggleRightDrawer?: () => void }) =>
  <header><button aria-label={leftDrawerOpen ? 'Close Sessions' : 'Open Sessions'} onClick={onToggleLeftDrawer} /><button aria-label="Open right drawer" onClick={onToggleRightDrawer} /></header> }));
for (const [path, name] of [
  ['./BottomTerminalDock', 'BottomTerminalDock'], ['./Sidebar', 'Sidebar'], ['./RightSidebar', 'RightSidebar'],
  ['./RightSidebarTabs', 'RightSidebarTabs'], ['./DesktopEdgeChrome', 'DesktopEdgeChrome'], ['./BotSidebarControlButton', 'BotSidebarControlButton'],
  ['./ContextPanel', 'ContextPanel'], ['./BrowserPanel', 'BrowserPanel'],
  ['@/components/ui/CommandPalette', 'CommandPalette'], ['@/components/ui/HelpDialog', 'HelpDialog'],
  ['@/components/ui/OpenCodeStatusDialog', 'OpenCodeStatusDialog'], ['@/components/session/SessionDialogs', 'SessionDialogs'],
  ['@/components/views/SettingsFrame', 'SettingsFrame'], ['@/components/views/ManagedSettingsFrame', 'ManagedSettingsFrame'],
] as const) mock.module(path, () => ({ [name]: passthrough, SIDEBAR_CONTENT_WIDTH: 280, RIGHT_SIDEBAR_CONTENT_WIDTH: 360 }));
mock.module('@/components/ui/ErrorBoundary', () => ({ ErrorBoundary: passthrough }));
mock.module('@/contexts/DiffWorkerProvider', () => ({ DiffWorkerProvider: passthrough }));
mock.module('@/components/multirun', () => ({ MultiRunLauncher: empty }));
mock.module('@/components/views/useSettingsEntryPreload', () => ({ useSettingsEntryPreload: empty }));
mock.module('@/components/views/config-apply/useConfigApplyStatusLifecycle', () => ({ useConfigApplyStatusLifecycle: empty }));
mock.module('@/components/views/lazyViews', () => ({ DeferredLazyView: empty, LazyViewBoundary: passthrough, LazyBotView: empty, LazyDiffView: empty, LazyGitView: empty, LazyMultiRunWindow: empty, LazyPlanView: empty, LazyTerminalView: empty }));
mock.module('@/components/views/ChatView', () => ({ ChatView: () => <textarea data-chat-input="true" /> }));

const { useUIStore } = await import('@/stores/useUIStore');
const { SidebarProjectsList } = await import('@/components/session/sidebar/SidebarProjectsList');
function ProjectSidebar({ mobileVariant = false }: { mobileVariant?: boolean }) {
  const context = useOptionalDrawer();
  if (mobileVariant) drawer = context;
  const state = useUIStore.getState();
  const sections = [{ project, groups: [] }];
  return <SidebarProjectsList
    sectionsForRender={sections} projectSections={sections} activeProjectId={activeProject}
    showOnlyMainWorkspace={false} hasSessionSearchQuery={false} emptyState={null} searchEmptyState={null}
    renderGroupSessions={() => null} homeDirectory={null} collapsedProjects={new Set()}
    hideProjectAdminControls={false} hideWorktreeControls={false} projectRepoStatus={new Map()}
    isDesktopShellRuntime={false} stuckProjectHeaders={new Set()} mobileVariant={mobileVariant}
    alwaysShowActions toggleProject={empty} setActiveProjectIdOnly={(id) => { activeProject = id; }}
    setActiveMainTab={state.setActiveMainTab} setSessionSwitcherOpen={state.setSessionSwitcherOpen}
    openNewSessionDraft={(options) => { drafts.push(options ?? {}); }} openNewWorktreeDialog={empty}
    openProjectEditDialog={empty} removeProject={empty} projectHeaderSentinelRefs={{ current: new Map() }}
    reorderProjects={empty} getOrderedGroups={(_id, groups) => groups} setGroupOrderByProject={empty}
    openSidebarMenuKey={null} setOpenSidebarMenuKey={empty} isInlineEditing={false}
  />;
}
mock.module('@/components/session/SessionSidebar', () => ({ SessionSidebar: ProjectSidebar }));
const { MainLayout } = await import('./MainLayout');

const required = (container: HostElement, label: string) => {
  const node = container.find((candidate) => candidate.getAttribute('aria-label') === label);
  if (!node) throw new Error(`Missing test control: ${label}`);
  return node;
};
const leftAside = (container: HostElement) => container.find((node) => node.tagName === 'ASIDE');
const currentDrawer = () => {
  if (!drawer) throw new Error('Mobile drawer context is absent');
  return drawer;
};
async function mounted(run: (container: HostElement, render: () => Promise<void>) => Promise<void>) {
  await withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    const original = useUIStore.getState();
    device = { isMobile: true, isTablet: false, screenWidth: 390 };
    Object.assign(window, { innerWidth: 390, innerHeight: 844 });
    drafts.length = 0; activeProject = 'another-project'; drawer = null;
    useUIStore.setState({ isSessionSwitcherOpen: false, isRightSidebarOpen: false, isSettingsDialogOpen: false, isMultiRunLauncherOpen: false, activeMainTab: 'chat' });
    const render = async () => { await act(async () => root.render(<MainLayout />)); };
    try { await render(); await run(container, render); }
    finally { await act(async () => root.unmount()); useUIStore.setState(original, true); }
  });
}

test('header-opened phone drawer closes on original exact-project draft dispatch and releases composer backdrop', async () => mounted(async (container) => {
  await act(async () => required(container, 'Open Sessions').click());
  expect(leftAside(container)?.getAttribute('aria-hidden')).toBe('false');
  await act(async () => required(container, 'New Draft Session').click());
  expect(activeProject).toBe(project.id);
  expect(drafts).toEqual([{ directoryOverride: '/qa/workspace' }]);
  expect(leftAside(container)?.getAttribute('aria-hidden')).toBe('true');
  expect(useUIStore.getState().isSessionSwitcherOpen).toBe(false);
  expect(currentDrawer().leftDrawerX.get()).toBe(-390 * 0.85);
  expect(Reflect.get(required(container, 'mainLayout.mobile.closeDrawerAria').style, 'pointerEvents')).toBe('none');
  expect(container.find((node) => node.getAttribute('data-chat-input') === 'true')).not.toBeNull();
}));

test('repeated header/context toggles, backdrop and external session close share one current flag', async () => mounted(async (container) => {
  await act(async () => required(container, 'Open Sessions').click());
  expect(useUIStore.getState().isSessionSwitcherOpen).toBe(true);
  await act(async () => required(container, 'mainLayout.mobile.closeDrawerAria').click());
  expect(useUIStore.getState().isSessionSwitcherOpen).toBe(false);
  const toggle = currentDrawer().toggleLeftDrawer;
  await act(async () => { toggle(); toggle(); });
  expect(leftAside(container)?.getAttribute('aria-hidden')).toBe('true');
  await act(async () => toggle());
  expect(useUIStore.getState().isSessionSwitcherOpen).toBe(true);
  await act(async () => useUIStore.getState().setSessionSwitcherOpen(false));
  expect(leftAside(container)?.getAttribute('aria-hidden')).toBe('true');
  // Retained context callback must read the latest store leaf, not its render.
  await act(async () => { currentDrawer().setMobileLeftDrawerOpen(true); });
  await act(async () => required(container, 'Open right drawer').click());
  expect(useUIStore.getState().isSessionSwitcherOpen).toBe(false);
  expect(useUIStore.getState().isRightSidebarOpen).toBe(true);
}));

test('mobile resize and desktop round-trip retain authoritative closed/open endpoints', async () => mounted(async (container, render) => {
  await act(async () => required(container, 'Open Sessions').click());
  device = { ...device, screenWidth: 844 }; Object.assign(window, { innerWidth: 844 });
  await render();
  expect(currentDrawer().leftDrawerWidth.current).toBe(844 * 0.85);
  expect(currentDrawer().leftDrawerX.get()).toBe(0);
  device = { isMobile: false, isTablet: false, screenWidth: 1280 }; Object.assign(window, { innerWidth: 1280 });
  await render();
  expect(leftAside(container)).toBeNull();
  await act(async () => useUIStore.getState().setSessionSwitcherOpen(false));
  device = { isMobile: true, isTablet: false, screenWidth: 390 }; Object.assign(window, { innerWidth: 390 });
  await render();
  expect(leftAside(container)?.getAttribute('aria-hidden')).toBe('true');
  expect(currentDrawer().leftDrawerX.get()).toBe(-390 * 0.85);
  await act(async () => useUIStore.getState().setSessionSwitcherOpen(true));
  await act(async () => useUIStore.getState().setSettingsDialogOpen(true));
  expect(useUIStore.getState().isSessionSwitcherOpen).toBe(false);
  expect(leftAside(container)?.getAttribute('aria-hidden')).toBe('true');
}));


test('drag fallback and threshold decisions publish matching owner state and motion endpoints', async () => mounted(async (container) => {
  await act(async () => required(container, 'Open Sessions').click());
  const width = currentDrawer().leftDrawerWidth.current;
  const drag = (position: number, offset: number, velocity: number) => {
    currentDrawer().leftDrawerX.set(position);
    if (!leftDragEnd) throw new Error('Original left drawer drag callback is absent');
    leftDragEnd(null, { offset: { x: offset }, velocity: { x: velocity } });
  };
  await act(async () => drag(-width * 0.75, 0, 0));
  expect(useUIStore.getState().isSessionSwitcherOpen).toBe(false);
  expect(leftAside(container)?.getAttribute('aria-hidden')).toBe('true');
  expect(currentDrawer().leftDrawerX.get()).toBe(-width);
  await act(async () => drag(-width * 0.25, 0, 0));
  expect(useUIStore.getState().isSessionSwitcherOpen).toBe(true);
  expect(leftAside(container)?.getAttribute('aria-hidden')).toBe('false');
  expect(currentDrawer().leftDrawerX.get()).toBe(0);
  await act(async () => drag(-1, -width * 0.4, 0));
  expect(useUIStore.getState().isSessionSwitcherOpen).toBe(false);
  expect(currentDrawer().leftDrawerX.get()).toBe(-width);
  await act(async () => drag(-width, 0, 501));
  expect(useUIStore.getState().isSessionSwitcherOpen).toBe(true);
  expect(currentDrawer().leftDrawerX.get()).toBe(0);
}));
