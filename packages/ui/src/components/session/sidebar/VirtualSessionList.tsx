import React from 'react';
import { AnimatePresence } from 'motion/react';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import { useDndContext } from '@dnd-kit/core';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import type { SessionNode } from './types';
import { flattenSessionRows } from './sidebarRowModel';
import { FlatSidebarRowContext, SidebarRowsContext } from './SidebarRowsContext';

type Props = {
  nodes: SessionNode[];
  directory?: string | null;
  projectId?: string | null;
  archived?: boolean;
  renderNode: (node: SessionNode, depth?: number, directory?: string | null, projectId?: string | null, archived?: boolean) => React.ReactNode;
  onExitComplete?: () => void;
};
const EMPTY_ROWS: import('./sidebarRowModel').SidebarModelRow[] = [];
const emptyRows = () => EMPTY_ROWS;
const EMPTY_PINS = new Set<string>();
const emptyPins = () => EMPTY_PINS;
const noSubscribe = () => () => {};

export function VirtualSessionList({ nodes, directory = null, projectId, archived = false, renderNode, onExitComplete }: Props) {
  const context = React.useContext(SidebarRowsContext);
  const modelRows = React.useSyncExternalStore(context?.model.subscribe ?? noSubscribe, context?.model.getRows ?? emptyRows);
  const openRows = React.useSyncExternalStore(context?.model.subscribePins ?? noSubscribe, context?.model.getPins ?? emptyPins);
  const [disabled] = React.useState(() => getSafeStorage().getItem('devryan:sidebar:virtualization') === 'off');
  const enabled = Boolean(context && modelRows.length > 200 && !disabled);
  const rows = React.useMemo(() => flattenSessionRows(nodes, context?.expanded ?? new Set(), context?.search ?? false, directory),
    [nodes, context?.expanded, context?.search, directory]);
  const container = React.useRef<HTMLDivElement>(null);
  const [margin, setMargin] = React.useState(0);
  const [focusedId, setFocusedId] = React.useState<string | null>(null);
  const pendingFocus = React.useRef<string | null>(null);
  const focusLast = React.useRef(false);
  const anchor = React.useRef<{ id: string; top: number } | null>(null);
  const { active } = useDndContext();
  const dragId = active?.data.current?.sessionId;
  const scrollElement = React.useCallback(() => container.current?.closest<HTMLElement>('[data-sidebar-scroll]') ?? null, []);
  const pinned = rows.flatMap((row, index) => row.node.session.id === anchor.current?.id || openRows.has(row.node.session.id) || row.node.session.id === focusedId || row.node.session.id === dragId
    || row.node.session.id === context?.editingId || context?.menuKey?.endsWith(`:${row.node.session.id}`) ? [index] : []);
  const virtualizer = useVirtualizer({
    count: rows.length, enabled, getScrollElement: scrollElement, estimateSize: () => 32,
    getItemKey: (index) => rows[index].node.session.id, overscan: 10, scrollMargin: margin,
    rangeExtractor: (range) => [...new Set([...defaultRangeExtractor(range), ...pinned])].sort((a, b) => a - b),
  });
  React.useLayoutEffect(() => {
    if (!enabled) return;
    const parent = scrollElement(), element = container.current;
    if (!parent || !element) return;
    const measure = () => setMargin(element.getBoundingClientRect().top - parent.getBoundingClientRect().top + parent.scrollTop);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element); observer.observe(parent);
    // Preceding groups can move this list without resizing it.
    parent.querySelectorAll('[data-sidebar-virtual-list]').forEach((list) => observer.observe(list));
    parent.addEventListener('scroll', measure, { passive: true });
    return () => { observer.disconnect(); parent.removeEventListener('scroll', measure); };
  }, [enabled, modelRows, scrollElement]);
  const previousSelected = React.useRef<string | null | undefined>(undefined);
  const previousCount = React.useRef(rows.length);
  const previouslyVirtual = React.useRef(enabled);
  React.useEffect(() => {
    if ((enabled || previouslyVirtual.current) && rows.length < previousCount.current) {
      // Windowed rows disappear without an exit animation. Notify after the
      // parent's removal effect has set its empty-state animation guard.
      queueMicrotask(() => onExitComplete?.());
    }
    previousCount.current = rows.length;
    previouslyVirtual.current = enabled;
  }, [enabled, rows.length, onExitComplete]);
  React.useLayoutEffect(() => {
    const current = context?.currentSessionId;
    if (enabled && current !== previousSelected.current) {
      const index = rows.findIndex((row) => row.node.session.id === current);
      if (index >= 0) { anchor.current = null; virtualizer.scrollToIndex(index, { align: 'auto' }); }
    }
    previousSelected.current = enabled ? current : undefined;
  }, [context?.currentSessionId, enabled, rows, virtualizer]);
  React.useLayoutEffect(() => {
    if (!pendingFocus.current) return;
    const row = container.current?.querySelector<HTMLElement>(`[data-session-row="${CSS.escape(pendingFocus.current)}"]`);
    const stops = row ? Array.from(row.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),[tabindex="0"]')).filter((element) => element.getClientRects().length) : [];
    const target = focusLast.current ? stops.at(-1) : row?.querySelector<HTMLElement>('[data-session-select]');
    if (target) { target.focus({ preventScroll: true }); pendingFocus.current = null; }
  });
  React.useLayoutEffect(() => {
    if (!enabled) return;
    const parent = scrollElement(), element = container.current;
    if (!parent || !element) return;
    const capture = () => {
      const top = parent.getBoundingClientRect().top;
      const visible = Array.from(element.querySelectorAll<HTMLElement>('[data-session-row]')).find((row) => row.getBoundingClientRect().bottom > top);
      if (visible?.dataset.sessionRow) anchor.current = { id: visible.dataset.sessionRow, top: visible.getBoundingClientRect().top - top };
    };
    if (anchor.current) {
      const row = element.querySelector<HTMLElement>(`[data-session-row="${CSS.escape(anchor.current.id)}"]`);
      if (row) parent.scrollTop += row.getBoundingClientRect().top - parent.getBoundingClientRect().top - anchor.current.top;
    }
    capture(); parent.addEventListener('scroll', capture, { passive: true });
    return () => parent.removeEventListener('scroll', capture);
  }, [enabled, rows, margin, scrollElement]);
  if (!enabled) return <AnimatePresence initial={false} onExitComplete={onExitComplete}>
    {nodes.map((node) => <React.Fragment key={node.session.id}>{renderNode(node, 0, directory, projectId, archived)}</React.Fragment>)}
  </AnimatePresence>;
  return <FlatSidebarRowContext.Provider value>
    <div ref={container} data-sidebar-virtual-list role="tree" style={{ height: virtualizer.getTotalSize(), position: 'relative', overflowAnchor: 'none' }}
      onFocusCapture={(event) => setFocusedId((event.target as HTMLElement).closest<HTMLElement>('[data-session-row]')?.dataset.sessionRow ?? null)}
      onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedId(null); }}
      onKeyDown={(event) => {
        if (!(event.target instanceof HTMLElement) || event.defaultPrevented) return;
        if (event.key === 'Tab') {
          const row = event.target.closest<HTMLElement>('[data-session-row]');
          const stops = row ? Array.from(row.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),[tabindex="0"]')).filter((element) => element.getClientRects().length) : [];
          if (event.target !== (event.shiftKey ? stops[0] : stops.at(-1))) return;
        } else if (!event.target.hasAttribute('data-session-select')) return;
        const id = event.target.closest<HTMLElement>('[data-session-row]')?.dataset.sessionRow;
        const index = rows.findIndex((row) => row.node.session.id === id);
        const target = event.key === 'ArrowDown' || event.key === 'Tab' && !event.shiftKey ? index + 1 : event.key === 'ArrowUp' || event.key === 'Tab' && event.shiftKey ? index - 1
          : event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : -1;
        if (index < 0 || target < 0 || target >= rows.length) return;
        event.preventDefault(); event.stopPropagation();
        anchor.current = null; focusLast.current = event.key === 'Tab' && event.shiftKey;
        pendingFocus.current = rows[target].node.session.id; setFocusedId(pendingFocus.current);
        virtualizer.scrollToIndex(target, { align: 'auto' });
      }}>
      {virtualizer.getVirtualItems().map((item) => {
        const row = rows[item.index];
        return <div key={item.key} data-index={item.index} ref={virtualizer.measureElement} role="treeitem" aria-level={row.depth + 1}
          aria-expanded={row.node.children.length ? (context?.search || context?.expanded.has(row.node.session.id)) : undefined}
          style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start - margin}px)` }}>
          {renderNode(row.node, row.depth, row.directory, projectId, archived)}
        </div>;
      })}
    </div>
  </FlatSidebarRowContext.Provider>;
}
