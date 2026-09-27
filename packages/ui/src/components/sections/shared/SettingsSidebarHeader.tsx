import React from 'react';
import { Button } from '@/components/ui/button';
import { RiAddLine } from '@remixicon/react';
import { useDeviceInfo } from '@/lib/device';
import { cn } from '@/lib/utils';

interface SettingsSidebarHeaderProps {
  /** Sidebar title. When set, the header renders as one titled block. */
  title?: React.ReactNode;
  /** Controls to the right of the title (for example a refresh or catalog button). */
  titleActions?: React.ReactNode;
  /** Controls between the title and the count row (search, project selector). */
  children?: React.ReactNode;
  /** Total count to display (e.g., "Total 5"). Ignored when `countLabel` is set. */
  count?: number;
  /** Custom label prefix for `count` (default: "Total") */
  label?: string;
  /** Preformatted count text, for example a translated "Total 5" or a match count. */
  countLabel?: React.ReactNode;
  /** Callback when add button is clicked. If undefined, no add button is shown. */
  onAdd?: () => void;
  /** Aria label for the add button */
  addButtonLabel?: string;
  /** Tooltip for the add button */
  addButtonTitle?: string;
  /** Disables the add button */
  addDisabled?: boolean;
}

/**
 * Standard header for settings sidebars: an optional title row with actions,
 * an optional controls slot, then the item count and an optional add button.
 *
 * @example
 * <SettingsSidebarHeader
 *   title="Skills"
 *   titleActions={<CatalogButton />}
 *   countLabel={t('settings.skills.sidebar.total', { count })}
 *   onAdd={() => setCreateDialogOpen(true)}
 *   addButtonLabel="Create Skill"
 * >
 *   <SearchInput />
 * </SettingsSidebarHeader>
 */
export const SettingsSidebarHeader: React.FC<SettingsSidebarHeaderProps> = ({
  title,
  titleActions,
  children,
  count,
  label = 'Total',
  countLabel,
  onAdd,
  addButtonLabel = 'Add New Item',
  addButtonTitle,
  addDisabled = false,
}) => {
  const { isMobile } = useDeviceInfo();
  const resolvedCountLabel = countLabel ?? (typeof count === 'number' ? `${label} ${count}` : null);

  const countRow = (resolvedCountLabel !== null || onAdd) ? (
    <div className="flex min-h-7 items-center justify-between gap-2">
      <span className="typography-meta text-muted-foreground">
        {resolvedCountLabel}
      </span>
      {onAdd && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 -my-1 text-muted-foreground"
          onClick={onAdd}
          disabled={addDisabled}
          aria-label={addButtonLabel}
          title={addButtonTitle}
        >
          <RiAddLine className="size-4" />
        </Button>
      )}
    </div>
  ) : null;

  if (title === undefined) {
    return (
      <div
        className={cn(
          'border-b px-3',
          isMobile ? 'mt-2 py-3' : 'py-3'
        )}
      >
        {countRow}
      </div>
    );
  }

  return (
    <div className="border-b px-3 pt-4 pb-3">
      <div className="mb-2 flex min-h-7 items-center justify-between gap-2">
        <h2 className="min-w-0 truncate text-base font-semibold text-foreground">{title}</h2>
        {titleActions ? <div className="flex shrink-0 items-center gap-1">{titleActions}</div> : null}
      </div>
      <div className="mb-2 space-y-2 empty:hidden">{children}</div>
      {countRow}
    </div>
  );
};
