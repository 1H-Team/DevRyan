import React from 'react';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS as DndCSS } from '@dnd-kit/utilities';
import { RiAddLine, RiCloseLine, RiGlobalLine } from '@remixicon/react';

import { handleClosableTabAuxClick } from '@/components/ui/sortableTabsStripAuxClick';
import { cn } from '@/lib/utils';

export type BrowserTabStripItem = {
  id: string;
  label: string;
  title?: string;
  faviconUrl?: string;
  loading?: boolean;
  leaseDot?: boolean;
  closable?: boolean;
  sortable?: boolean;
};

type BrowserTabStripProps = {
  items: readonly BrowserTabStripItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onReorder: (activeId: string, overId: string) => void;
  onAdd: () => void;
  trailingActions?: React.ReactNode;
  className?: string;
};

const restrictToXAxis: Modifier = ({ transform }) => ({ ...transform, y: 0 });

const BrowserFavicon: React.FC<Pick<BrowserTabStripItem, 'faviconUrl' | 'loading' | 'leaseDot'>> = ({
  faviconUrl,
  loading,
  leaseDot,
}) => {
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => setFailed(false), [faviconUrl]);

  return (
    <span className="relative inline-flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
      {loading ? (
        <span className="size-3.5 animate-spin rounded-full border border-current border-r-transparent" />
      ) : faviconUrl && !failed ? (
        <img
          src={faviconUrl}
          alt=""
          referrerPolicy="no-referrer"
          className="size-4 rounded-[3px] object-contain"
          onError={() => setFailed(true)}
        />
      ) : (
        // Standalone-web iframe surfaces do not currently expose favicon
        // metadata, so they deliberately retain the globe fallback.
        <RiGlobalLine className="size-4" />
      )}
      {leaseDot ? (
        <span className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-[var(--status-info)] ring-1 ring-[var(--surface-background)]" />
      ) : null}
    </span>
  );
};

const SortableBrowserTab: React.FC<{ id: string; children: React.ReactNode }> = ({ id, children }) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      data-browser-tab-id={id}
      className={cn('h-full min-w-[72px] max-w-[240px] flex-1 basis-0', isDragging && 'z-30 opacity-60')}
      style={{ transform: DndCSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  );
};

const StaticBrowserTab: React.FC<{ id: string; children: React.ReactNode }> = ({ id, children }) => (
  <div data-browser-tab-id={id} className="h-full min-w-[72px] max-w-[240px] flex-1 basis-0">
    {children}
  </div>
);

export const BrowserTabStrip: React.FC<BrowserTabStripProps> = ({
  items,
  activeId,
  onSelect,
  onClose,
  onReorder,
  onAdd,
  trailingActions,
  className,
}) => {
  const [hoveredId, setHoveredId] = React.useState<string | null>(null);
  const sortableIds = React.useMemo(
    () => items.filter((item) => item.sortable !== false).map((item) => item.id),
    [items],
  );
  const sortableIdSet = React.useMemo(() => new Set(sortableIds), [sortableIds]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const handleDragEnd = React.useCallback((event: DragEndEvent) => {
    const active = String(event.active.id);
    const over = event.over ? String(event.over.id) : '';
    if (!over || active === over || !sortableIdSet.has(active) || !sortableIdSet.has(over)) return;
    onReorder(active, over);
  }, [onReorder, sortableIdSet]);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToXAxis]}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={sortableIds} strategy={horizontalListSortingStrategy}>
        <div className={cn('flex h-8 min-w-0 flex-1 bg-[var(--surface-elevated)]', className)}>
          <div
            role="tablist"
            aria-label="Browser Tabs"
            className="flex min-w-0 flex-1 items-end overflow-x-auto overflow-y-hidden"
          >
            {items.map((item, index) => {
              const active = item.id === activeId;
              const previous = items[index - 1];
              const next = items[index + 1];
              const separatorVisible = !active
                && next?.id !== activeId
                && hoveredId !== item.id
                && hoveredId !== next?.id;
              const Wrapper = item.sortable === false ? StaticBrowserTab : SortableBrowserTab;
              const closable = item.closable !== false;
              return (
                <Wrapper key={item.id} id={item.id}>
                  <div
                    className={cn(
                      'group relative flex h-full min-w-0 items-center transition-colors',
                      active
                        ? 'z-20 rounded-t-[8px] bg-[var(--surface-background)] text-foreground'
                        : 'z-10 text-muted-foreground hover:bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)] hover:text-foreground',
                    )}
                    onMouseEnter={() => setHoveredId(item.id)}
                    onMouseLeave={() => setHoveredId((current) => current === item.id ? null : current)}
                    onAuxClick={(event) => handleClosableTabAuxClick(event, item.id, closable ? onClose : undefined)}
                  >
                    {active ? (
                      <>
                        <span
                          aria-hidden="true"
                          className="pointer-events-none absolute -bottom-px -left-2 size-2 bg-[var(--surface-background)]"
                          style={{ WebkitMaskImage: 'radial-gradient(circle at 0 0, transparent 7px, black 7.5px)', maskImage: 'radial-gradient(circle at 0 0, transparent 7px, black 7.5px)' }}
                        />
                        <span
                          aria-hidden="true"
                          className="pointer-events-none absolute -bottom-px -right-2 size-2 bg-[var(--surface-background)]"
                          style={{ WebkitMaskImage: 'radial-gradient(circle at 100% 0, transparent 7px, black 7.5px)', maskImage: 'radial-gradient(circle at 100% 0, transparent 7px, black 7.5px)' }}
                        />
                      </>
                    ) : null}
                    <button
                      type="button"
                      role="tab"
                      aria-selected={active}
                      title={item.title ?? item.label}
                      className="flex h-full min-w-0 flex-1 items-center gap-2 px-3 text-left typography-ui-label focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--interactive-focus-ring)]"
                      onClick={() => onSelect(item.id)}
                    >
                      <BrowserFavicon faviconUrl={item.faviconUrl} loading={item.loading} leaseDot={item.leaseDot} />
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    </button>
                    {closable ? (
                      <button
                        type="button"
                        aria-label={`Close ${item.label} tab`}
                        className={cn(
                          'mr-1.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full transition-[background-color,opacity] hover:bg-[color-mix(in_srgb,var(--foreground)_12%,transparent)] focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
                          active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
                        )}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          onClose(item.id);
                        }}
                      >
                        <RiCloseLine className="size-3.5" />
                      </button>
                    ) : null}
                    {separatorVisible && previous?.id !== activeId ? (
                      <span aria-hidden="true" className="pointer-events-none absolute right-0 top-2 h-4 w-px bg-border/70" />
                    ) : null}
                  </div>
                </Wrapper>
              );
            })}
            <button
              type="button"
              aria-label="New Browser Tab"
              title="New Browser Tab"
              className="mx-1 mb-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
              onClick={onAdd}
            >
              <RiAddLine className="size-4" />
            </button>
            <span className="min-w-2 flex-1" aria-hidden="true" />
          </div>
          {trailingActions ? <div className="flex shrink-0 items-center gap-1 px-1.5">{trailingActions}</div> : null}
        </div>
      </SortableContext>
    </DndContext>
  );
};
