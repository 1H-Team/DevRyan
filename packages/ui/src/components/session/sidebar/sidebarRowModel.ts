import type { SessionNode } from './types';
import { resolveSessionRoutingDirectory } from './utils';

export type SidebarRowOrder = number | readonly [project: number, group: number];
export type SidebarModelRow = { id: string; scope: string | null; archived: boolean; selectable: boolean; descendants: string[] };
export type FlatSessionRow = { node: SessionNode; depth: number; directory: string | null };

export function flattenSessionRows(nodes: SessionNode[], expanded: Set<string>, search: boolean, directory: string | null): FlatSessionRow[] {
  const rows: FlatSessionRow[] = [];
  const visit = (node: SessionNode, depth: number, parentDirectory: string | null) => {
    const scope = resolveSessionRoutingDirectory(null, node.session.directory, parentDirectory);
    rows.push({ node, depth, directory: scope });
    if (search || expanded.has(node.session.id)) for (const child of node.children) visit(child, depth + 1, scope);
  };
  for (const node of nodes) visit(node, 0, directory);
  return rows;
}

export function sessionModelRows(rows: FlatSessionRow[], archived: boolean): SidebarModelRow[] {
  const descendants = (node: SessionNode): string[] => node.children.flatMap((child) => [child.session.id, ...descendants(child)]);
  return rows.map(({ node, directory }) => ({ id: node.session.id, scope: directory, archived,
    selectable: !node.isArchiveAncestorOnly, descendants: descendants(node) }));
}

export function createSidebarRowModel() {
  const groups = new Map<string, { order: SidebarRowOrder; rows: SidebarModelRow[] }>();
  const listeners = new Set<() => void>();
  let rows: SidebarModelRow[] = [];
  const pinCounts = new Map<string, number>();
  const pinListeners = new Set<() => void>();
  let pins = new Set<string>();
  const publishPins = () => { pins = new Set(pinCounts.keys()); for (const listener of pinListeners) listener(); };
  const publish = () => {
    const next = [...groups.values()].sort((a, b) => (typeof a.order === 'number' ? a.order : a.order[0]) - (typeof b.order === 'number' ? b.order : b.order[0]) || (typeof a.order === 'number' ? 0 : a.order[1]) - (typeof b.order === 'number' ? 0 : b.order[1])).flatMap((group) => group.rows);
    if (JSON.stringify(next) === JSON.stringify(rows)) return;
    rows = next; for (const listener of listeners) listener();
  };
  return {
    subscribePins: (listener: () => void) => { pinListeners.add(listener); return () => { pinListeners.delete(listener); }; },
    getPins: () => pins,
    pin: (id: string) => {
      pinCounts.set(id, (pinCounts.get(id) ?? 0) + 1); publishPins();
      return () => { const count = (pinCounts.get(id) ?? 1) - 1; if (count) pinCounts.set(id, count); else pinCounts.delete(id); publishPins(); };
    },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getRows: () => rows,
    set: (key: string, order: SidebarRowOrder, next: SidebarModelRow[]) => { groups.set(key, { order, rows: next }); publish(); },
    remove: (key: string) => { groups.delete(key); publish(); },
  };
}

export const selectableModelRows = (rows: SidebarModelRow[], scope?: string | null) => rows.filter((row) => row.selectable && (!scope || row.scope === scope));
