import React from 'react';
import { RiArrowDownSLine, RiArrowRightSLine, RiFolder3Line, RiFolderOpenLine } from '@remixicon/react';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import { cn } from '@/lib/utils';

/** Same key shape the shared SidebarGroup uses, so collapse state carries over. */
function getStorageKey(storageKey: string, label: string): string {
  return `opencode:sidebar-group:${storageKey}:${label}`;
}

function usePersistedExpanded(key: string, defaultExpanded: boolean, forceExpandedOnMount = false) {
  const [expanded, setExpanded] = React.useState<boolean>(() => {
    if (forceExpandedOnMount) return true;
    try {
      const stored = getSafeStorage().getItem(key);
      if (stored !== null) return stored === 'true';
    } catch {
      // ignore storage errors
    }
    return defaultExpanded;
  });

  React.useEffect(() => {
    try {
      getSafeStorage().setItem(key, String(expanded));
    } catch {
      // ignore storage errors
    }
  }, [key, expanded]);

  return [expanded, setExpanded] as const;
}

interface SkillLocationGroupProps {
  label: string;
  count: number;
  storageKey: string;
  children: React.ReactNode;
}

/**
 * Top level of the skills tree: a scope/source location such as "User / Agents".
 * Rendered as a flat section header — no indent rail, so skill names keep the
 * full sidebar width instead of paying for two levels of nesting.
 */
export const SkillLocationGroup: React.FC<SkillLocationGroupProps> = ({
  label,
  count,
  storageKey,
  children,
}) => {
  const key = getStorageKey(storageKey, label);
  const contentId = React.useId();
  const [expanded, setExpanded] = usePersistedExpanded(key, true);

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

interface SkillFolderGroupProps {
  label: string;
  count: number;
  storageKey: string;
  /** Highlights the folder and its guide rail while it holds the selected skill. */
  containsSelected: boolean;
  /** Bumped by the sidebar when the tree comes back after a search; a folder
   *  holding the selection expands so the skill the user just picked is visible. */
  revealNonce?: number;
  children: React.ReactNode;
}

/**
 * Second level of the skills tree: a domain folder such as "Cloudflare".
 * Reads as a folder row rather than a second section header, so the two levels
 * of the tree are told apart by shape instead of indentation alone.
 */
export const SkillFolderGroup: React.FC<SkillFolderGroupProps> = ({
  label,
  count,
  storageKey,
  containsSelected,
  revealNonce = 0,
  children,
}) => {
  const key = getStorageKey(storageKey, label);
  const contentId = React.useId();
  // Reveal the selected skill when it lands inside a collapsed folder — either by
  // moving here, or because the sidebar asked for a reveal after a search (the tree
  // remounts then, so that case has to be handled at mount). A collapse the user
  // performs afterwards still sticks.
  const [expanded, setExpanded] = usePersistedExpanded(key, true, containsSelected && revealNonce > 0);

  const previouslyContainedSelected = React.useRef(containsSelected);
  const previousRevealNonce = React.useRef(revealNonce);
  React.useEffect(() => {
    const selectionArrived = containsSelected && !previouslyContainedSelected.current;
    const revealRequested = containsSelected && revealNonce !== previousRevealNonce.current;
    if (selectionArrived || revealRequested) {
      setExpanded(true);
    }
    previouslyContainedSelected.current = containsSelected;
    previousRevealNonce.current = revealNonce;
  }, [containsSelected, revealNonce, setExpanded]);

  const FolderIcon = expanded ? RiFolderOpenLine : RiFolder3Line;

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={contentId}
        className={cn(
          'group/folder flex w-full items-center gap-1 rounded-md py-1 pl-1 pr-1.5 text-left',
          'hover:bg-interactive-hover transition-colors duration-150',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
        )}
      >
        <RiArrowRightSLine
          className={cn(
            'h-3.5 w-3.5 flex-shrink-0 text-muted-foreground transition-transform duration-200',
            expanded && 'rotate-90',
          )}
        />
        <FolderIcon
          className={cn(
            'h-3.5 w-3.5 flex-shrink-0 transition-colors',
            containsSelected ? 'text-primary' : 'text-muted-foreground/70',
          )}
        />
        <span
          className={cn(
            'typography-ui-label flex-1 truncate',
            containsSelected ? 'font-medium text-foreground' : 'font-normal text-foreground/80',
          )}
        >
          {label}
        </span>
        {containsSelected && !expanded ? (
          <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary" aria-hidden />
        ) : null}
        <span className="typography-micro ml-1 flex-shrink-0 tabular-nums text-muted-foreground/70">{count}</span>
      </button>

      <div
        id={contentId}
        hidden={!expanded}
        className={cn(
          'mt-0.5 space-y-0.5 ml-[11px] border-l pl-2',
          containsSelected ? 'border-primary/30' : 'border-[var(--interactive-border)]',
        )}
      >
        {children}
      </div>
    </div>
  );
};
