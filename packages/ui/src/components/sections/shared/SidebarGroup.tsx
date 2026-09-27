import { getSafeStorage } from '@/stores/utils/safeStorage';
import React, { useState, useEffect } from 'react';
import { RiArrowDownSLine } from '@remixicon/react';
import { cn } from '@/lib/utils';

interface SidebarGroupProps {
  /** Group display label (e.g. "Project", "User / Agents") */
  label: string;
  /** Number of items in this group */
  count: number;
  /** Unique storage key prefix for persisting collapse state */
  storageKey: string;
  /** Whether to start expanded. Defaults to true. */
  defaultExpanded?: boolean;
  children: React.ReactNode;
}

function getStorageKey(storageKey: string, label: string): string {
  return `opencode:sidebar-group:${storageKey}:${label}`;
}

/**
 * Collapsible top-level group for settings sidebars with persisted state.
 * Rendered as a flat section header — no indent rail — so item names keep the
 * full sidebar width. Used by the Plugins, Skills and MCP Servers sidebars.
 */
export const SidebarGroup: React.FC<SidebarGroupProps> = ({
  label,
  count,
  storageKey,
  defaultExpanded = true,
  children,
}) => {
  const key = getStorageKey(storageKey, label);
  const contentId = React.useId();

  const [expanded, setExpanded] = useState<boolean>(() => {
    try {
      const stored = getSafeStorage().getItem(key);
      if (stored !== null) return stored === 'true';
    } catch {
      // ignore storage errors
    }
    return defaultExpanded;
  });

  useEffect(() => {
    try {
      getSafeStorage().setItem(key, String(expanded));
    } catch {
      // ignore storage errors
    }
  }, [key, expanded]);

  return (
    <div className="pt-1 first:pt-0">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={contentId}
        className={cn(
          'flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-left',
          'typography-micro font-semibold uppercase tracking-[0.08em] text-muted-foreground/80',
          'hover:bg-interactive-hover hover:text-muted-foreground transition-colors duration-150',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
        )}
      >
        <RiArrowDownSLine
          className={cn(
            'h-3.5 w-3.5 flex-shrink-0 transition-transform duration-200',
            !expanded && '-rotate-90',
          )}
        />
        <span className="flex-1 truncate">{label}</span>
        <span className="ml-1 tabular-nums opacity-70">{count}</span>
      </button>

      <div id={contentId} hidden={!expanded} className="mt-0.5 space-y-0.5">
        {children}
      </div>
    </div>
  );
};
