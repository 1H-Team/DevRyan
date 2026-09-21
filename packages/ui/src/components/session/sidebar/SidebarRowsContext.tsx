import React from 'react';
import type { createSidebarRowModel } from './sidebarRowModel';

export type SidebarRowsContextValue = {
  model: ReturnType<typeof createSidebarRowModel>;
  expanded: Set<string>;
  search: boolean;
  editingId: string | null;
  menuKey: string | null;
  currentSessionId: string | null;
};
export const SidebarRowsContext = React.createContext<SidebarRowsContextValue | null>(null);
export const FlatSidebarRowContext = React.createContext(false);
