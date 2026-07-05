import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Session } from '@opencode-ai/sdk/v2';
import { hasTreeExpansionStateChange } from './sessionNodeMemo';
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
});
