import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Session } from '@opencode-ai/sdk/v2';
import { hasTreeExpansionStateChange } from './sessionNodeMemo';
import { resolveSessionRowAuxAction } from './sessionRowAuxAction';
import type { SessionNode } from './types';

const session = (id: string): Session => ({
  id,
  title: id,
  time: { created: 1, updated: 1 },
} as Session);

const node = (id: string, children: SessionNode[] = []): SessionNode => ({
  session: session(id),
  children,
  worktree: null,
});

describe('hasTreeExpansionStateChange', () => {
  test('detects expansion changes for descendant session rows', () => {
    const tree = node('parent', [
      node('child', [
        node('grandchild'),
      ]),
    ]);

    expect(hasTreeExpansionStateChange(
      tree,
      tree,
      new Set(['parent']),
      new Set(['parent', 'child']),
    )).toBe(true);
  });
});

describe('resolveSessionRowAuxAction', () => {
  test('archives active sessions on middle click', () => {
    expect(resolveSessionRowAuxAction(1, false, false)).toBe('archive');
  });

  test('permanently deletes genuine archived sessions on middle click', () => {
    expect(resolveSessionRowAuxAction(1, true, false)).toBe('delete');
  });

  test('leaves archived structural ancestor rows inert', () => {
    expect(resolveSessionRowAuxAction(1, true, true)).toBeNull();
  });

  test('ignores non-middle mouse buttons', () => {
    expect(resolveSessionRowAuxAction(0, false, false)).toBeNull();
    expect(resolveSessionRowAuxAction(2, true, false)).toBeNull();
  });

  test('wires the archived action to the existing hard-delete callback', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'SessionNodeItem.tsx'), 'utf8');

    const handlerStart = source.indexOf('const handleRowAuxClick');
    const handlerEnd = source.indexOf('const handleRowPointerDown', handlerStart);
    const handler = source.slice(handlerStart, handlerEnd);

    expect(handler).toContain("if (auxAction === 'delete')");
    expect(handler).toContain('handleDeleteSession(session, { archivedBucket: true })');
    expect(handler).toContain('handleArchiveSession(session)');
  });
});

describe('SessionNodeItem row hover metadata', () => {
  test('does not render session activity metadata in a row hover tooltip', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'SessionNodeItem.tsx'), 'utf8');

    expect(source).not.toContain('TooltipContent side="right" sideOffset={8} className="max-w-xs text-left"');
    expect(source).not.toContain('{sessionUpdatedLabel}</div>');
  });

  test('wires compact metadata to a row-local responsive container', () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(testDir, 'SessionNodeItem.tsx'), 'utf8');
    const styles = readFileSync(join(testDir, '..', '..', '..', 'index.css'), 'utf8');

    expect(source).toContain('@container/session-sidebar-row');
    expect(source).toContain('session-sidebar-row__compact-time');
    expect(styles).toContain('@container session-sidebar-row');
    expect(styles).toContain('.session-sidebar-row__compact-time');
  });
});

describe('SessionNodeItem status selectors', () => {
  test('checks only the row scope instead of scanning every session notification', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'SessionNodeItem.tsx'), 'utf8');

    expect(source).toContain('state.index.session.unseenHasError[sessionId]');
    expect(source).not.toContain('Object.entries(state.index.session.unseenHasError)');
  });

  test('subscribes to one child-session manual recovery leaf', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'SessionNodeItem.tsx'), 'utf8');

    expect(source).toContain('managedOrchestrationSelectors.manualRecoveryTaskIdForChildSession(session.id)');
    expect(source).not.toContain('state.tasksById');
  });
});

describe('session sidebar quick hover actions', () => {
  test('exposes pin, unarchive, and archived delete hover action flags', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'SessionNodeItem.tsx'), 'utf8');

    expect(source).toContain('showQuickPinAction');
    expect(source).toContain('showQuickUnarchiveAction');
    expect(source).toContain('showQuickDeleteAction');
  });

  test('renders pin before archive and uses restore icon for unarchive', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'SessionNodeItem.tsx'), 'utf8');

    expect(source.indexOf('showQuickPinAction')).toBeLessThan(source.indexOf('showQuickArchiveAction'));
    expect(source).toContain('handleQuickPinClick');
    expect(source).toContain('handleQuickUnarchiveClick');
    expect(source).toContain('RiArrowGoBackLine');
  });

  test('renders archived delete after restore and uses the hard-delete path', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'SessionNodeItem.tsx'), 'utf8');

    expect(source.indexOf('showQuickUnarchiveAction')).toBeLessThan(source.indexOf('showQuickDeleteAction'));
    expect(source.indexOf('handleQuickUnarchiveClick')).toBeLessThan(source.indexOf('handleQuickDeleteClick'));
    expect(source).toContain('handleDeleteSession(session, { archivedBucket: true })');
    expect(source).toContain('RiDeleteBinLine');
  });
});

describe('session sidebar archive reflow animation wiring', () => {
  test('wraps session rows and mapped session lists with layout animation boundaries', () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const itemSource = readFileSync(join(testDir, 'SessionNodeItem.tsx'), 'utf8');
    const groupSource = readFileSync(join(testDir, 'SessionGroupSection.tsx'), 'utf8');
    const folderSource = readFileSync(join(testDir, '..', 'SessionFolderItem.tsx'), 'utf8');

    expect(itemSource).toContain('SessionSidebarMotionRow');
    expect(groupSource).toContain('AnimatePresence initial={false}');
    expect(folderSource).toContain('AnimatePresence initial={false}');

    // The children AnimatePresence must be nested INSIDE the
    // SessionSidebarMotionRow so the whole subtree collapses as one unit
    // on archive/unarchive (prevents children snapping out after the parent
    // row finishes its exit animation). Assert ordering: the children
    // AnimatePresence block appears before the motion row's closing tag.
    const motionRowOpen = itemSource.indexOf('<SessionSidebarMotionRow>');
    const motionRowClose = itemSource.indexOf('</SessionSidebarMotionRow>');
    const childrenAnimatePresence = itemSource.indexOf('hasChildren ?', motionRowOpen);
    expect(motionRowOpen).toBeGreaterThan(-1);
    expect(childrenAnimatePresence).toBeGreaterThan(motionRowOpen);
    expect(motionRowClose).toBeGreaterThan(childrenAnimatePresence);
  });

  test('collapses entering and exiting rows without scale animation', () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(testDir, 'SessionSidebarMotionRow.tsx'), 'utf8');
    const itemSource = readFileSync(join(testDir, 'SessionNodeItem.tsx'), 'utf8');

    expect(source).toContain("initial={{ gridTemplateRows: '0fr', opacity: 0 }}");
    expect(source).toContain("animate={{ gridTemplateRows: '1fr', opacity: 1 }}");
    expect(source).toContain("exit={{ gridTemplateRows: '0fr', opacity: 0 }}");
    expect(source).toContain("overflow: 'hidden'");
    expect(source).toContain("display: 'grid'");
    expect(source).toContain('minHeight: 0');
    expect(itemSource).toContain('left-[-10px]');
    expect(source).toContain('SESSION_LEADING_INDICATOR_CLIP_GUTTER_PX');
    expect(source).toContain('marginLeft: -SESSION_LEADING_INDICATOR_CLIP_GUTTER_PX');
    expect(source).toContain('paddingLeft: SESSION_LEADING_INDICATOR_CLIP_GUTTER_PX');
    expect(source).not.toContain('scale');
  });

  test('reuses the row motion for project and Archived section bodies', () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const motionSource = readFileSync(join(testDir, 'SessionSidebarMotionRow.tsx'), 'utf8');
    const itemSource = readFileSync(join(testDir, 'SessionNodeItem.tsx'), 'utf8');
    const projectSource = readFileSync(join(testDir, 'SidebarProjectsList.tsx'), 'utf8');
    const groupSource = readFileSync(join(testDir, 'SessionGroupSection.tsx'), 'utf8');

    expect(motionSource).toContain('withLeadingIndicatorGutter?: boolean;');
    expect(motionSource).toContain('withLeadingIndicatorGutter = true');
    expect(motionSource).toContain('...(withLeadingIndicatorGutter ? {');
    expect(itemSource).toContain('<SessionSidebarMotionRow>');

    expect(projectSource).toContain("import { AnimatePresence } from 'motion/react';");
    expect(projectSource).toContain('key={`project-body:${projectKey}`}');
    expect(projectSource).toContain('withLeadingIndicatorGutter={false}');

    expect(groupSource).toContain('{group.isArchivedBucket ? (');
    expect(groupSource).toContain('key={`archived-group-body:${groupKey}`}');
    expect(groupSource).toContain('withLeadingIndicatorGutter={false}');
    expect(groupSource).toContain(') : (!isCollapsed ? groupBody : null)}');
  });

  test('keeps section contents mounted inside their exit animation boundaries', () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const projectSource = readFileSync(join(testDir, 'SidebarProjectsList.tsx'), 'utf8');
    const groupSource = readFileSync(join(testDir, 'SessionGroupSection.tsx'), 'utf8');

    const projectPresence = projectSource.indexOf('<AnimatePresence initial={false}>');
    const projectMotionOpen = projectSource.indexOf('key={`project-body:${projectKey}`}', projectPresence);
    const projectDndContext = projectSource.indexOf('<DndContext', projectMotionOpen);
    const projectMotionClose = projectSource.indexOf('</SessionSidebarMotionRow>', projectDndContext);
    const projectPresenceClose = projectSource.indexOf('</AnimatePresence>', projectMotionClose);

    expect(projectPresence).toBeGreaterThan(-1);
    expect(projectMotionOpen).toBeGreaterThan(projectPresence);
    expect(projectDndContext).toBeGreaterThan(projectMotionOpen);
    expect(projectMotionClose).toBeGreaterThan(projectDndContext);
    expect(projectPresenceClose).toBeGreaterThan(projectMotionClose);

    const archivedGuard = groupSource.indexOf('{group.isArchivedBucket ? (');
    const archivedPresence = groupSource.indexOf('<AnimatePresence initial={false}>', archivedGuard);
    const archivedMotionOpen = groupSource.indexOf('key={`archived-group-body:${groupKey}`}', archivedPresence);
    const archivedBody = groupSource.indexOf('{groupBody}', archivedMotionOpen);
    const archivedMotionClose = groupSource.indexOf('</SessionSidebarMotionRow>', archivedBody);

    expect(archivedGuard).toBeGreaterThan(-1);
    expect(archivedPresence).toBeGreaterThan(archivedGuard);
    expect(archivedMotionOpen).toBeGreaterThan(archivedPresence);
    expect(archivedBody).toBeGreaterThan(archivedMotionOpen);
    expect(archivedMotionClose).toBeGreaterThan(archivedBody);
  });

  test('shows No chats instantly after row exit while preserving other empty-state motion', () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(testDir, 'SessionGroupSection.tsx'), 'utf8');
    const emptyStateGate = 'totalSessions === 0 && allFoldersForGroup.length === 0 && draftCount === 0 && !isExitAnimating && !shouldDeferNoChats';
    const emptyStateIndex = source.indexOf(emptyStateGate);
    const emptyStateInitialIndex = source.indexOf('initial={group.isArchivedBucket ?');

    expect(source).toContain("import { AnimatePresence, motion, useReducedMotion } from 'motion/react';");
    expect(source).toContain('const shouldReduceMotion = useReducedMotion();');
    expect(source).toContain('const isVisibleSessionCountDropping = visibleSessions.length < prevVisibleCountRef.current;');
    expect(source).toContain('const shouldDeferNoChats = !group.isArchivedBucket && isVisibleSessionCountDropping;');
    expect(source).toContain('<AnimatePresence initial={false} onExitComplete={() => setIsExitAnimating(false)}>');
    expect(source).toContain('const emptyStateContent = (');
    expect(source).toContain('const emptyState = shouldReduceMotion ? emptyStateContent : (');
    expect(source).toContain('<AnimatePresence initial={false}>');
    expect(emptyStateIndex).toBeGreaterThan(-1);
    expect(source.indexOf('{emptyState}', emptyStateIndex)).toBeGreaterThan(emptyStateIndex);
    expect(emptyStateInitialIndex).toBeGreaterThan(-1);
    expect(source.indexOf(': false}', emptyStateInitialIndex)).toBeGreaterThan(emptyStateInitialIndex);
    expect(source).toContain("group.isArchivedBucket ? { gridTemplateRows: '0fr', opacity: 0, y: -2 } : false");
    expect(source).toContain("animate={{ gridTemplateRows: '1fr', opacity: 1, y: 0 }}");
    expect(source).toContain("exit={{ gridTemplateRows: '0fr', opacity: 0, y: -2 }}");
  });
});

describe('session export outcome wiring', () => {
  test('uses the typed save coordinator and suppresses duplicate export attempts', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'SessionNodeItem.tsx'), 'utf8');

    expect(source).toContain("import { saveSessionExportMarkdown } from '@/lib/sessionExportSave';");
    expect(source).toContain('const exportInFlightRef = React.useRef(false);');
    expect(source).toContain('if (exportInFlightRef.current) return;');
    expect(source).toContain('exportInFlightRef.current = true;');
    expect(source).toContain('exportInFlightRef.current = false;');
    expect(source).not.toContain('saveAsMarkdownDesktop');
  });

  test('shows preparation feedback and handles saved, downloaded, canceled, and failed outcomes separately', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'SessionNodeItem.tsx'), 'utf8');

    expect(source).toContain("toast.loading(t('sessions.sidebar.session.export.preparing')");
    expect(source).toContain("saveResult.status === 'canceled'");
    expect(source).toContain("saveResult.status === 'downloaded'");
    expect(source).toContain("t('sessions.sidebar.session.export.downloaded')");
    expect(source).toContain("t('sessions.sidebar.session.export.failed')");
    expect(source).toContain("saveResult.status === 'saved' && saveResult.path");
  });

  test('starts destination selection while asynchronous chat preparation is still in flight', () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'SessionNodeItem.tsx'), 'utf8');

    expect(source).toContain('const preparedExportPromise = (async () => {');
    expect(source).toContain('saveSessionExportMarkdown(\n        preparedExportPromise.then((prepared) => prepared.markdown),');
    expect(source.indexOf('const saveResult = await saveSessionExportMarkdown('))
      .toBeLessThan(source.indexOf('const preparedExport = await preparedExportPromise;'));
  });
});
