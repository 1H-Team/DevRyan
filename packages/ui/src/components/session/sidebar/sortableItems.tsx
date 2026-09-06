import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import {
  RiAddLine,
  RiCloseLine,
  RiFolderLine,
  RiMore2Line,
  RiNodeTree,
  RiPencilAiLine,
} from '@remixicon/react';
import { cn } from '@/lib/utils';
import { PROJECT_COLOR_MAP, PROJECT_ICON_MAP, getProjectIconImageUrl } from '@/lib/projectMeta';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useI18n } from '@/lib/i18n';

export interface SortableProjectItemProps {
  id: string;
  projectLabel: string;
  projectDescription: string;
  projectIcon?: string;
  projectColor?: string;
  projectIconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' };
  projectIconBackground?: string;
  isCollapsed: boolean;
  isActiveProject: boolean;
  isRepo: boolean;
  isDesktopShell: boolean;
  isStuck: boolean;
  hideProjectAdminControls: boolean;
  hideWorktreeControls: boolean;
  mobileVariant: boolean;
  alwaysShowActions: boolean;
  onToggle: () => void;
  onNewSession: () => void;
  onNewWorktreeSession?: () => void;
  onRenameStart: () => void;
  onClose: () => void;
  sentinelRef: (el: HTMLDivElement | null) => void;
  children?: React.ReactNode;
  showCreateButtons?: boolean;
  hideHeader?: boolean;
  openSidebarMenuKey: string | null;
  setOpenSidebarMenuKey: (key: string | null) => void;
}

export type SortableDragHandleProps = {
  listeners: ReturnType<typeof useSortable>['listeners'];
  setActivatorNodeRef: ReturnType<typeof useSortable>['setActivatorNodeRef'];
};

export const SortableProjectItem: React.FC<SortableProjectItemProps> = ({
  id,
  projectLabel,
  projectDescription,
  projectIcon,
  projectColor,
  projectIconImage,
  projectIconBackground,
  isCollapsed,
  isActiveProject,
  isRepo,
  isDesktopShell,
  isStuck,
  hideProjectAdminControls,
  hideWorktreeControls,
  alwaysShowActions,
  onToggle,
  onNewSession,
  onNewWorktreeSession,
  onRenameStart,
  onClose,
  sentinelRef,
  children,
  showCreateButtons = true,
  hideHeader = false,
  openSidebarMenuKey,
  setOpenSidebarMenuKey,
}) => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const [imageFailed, setImageFailed] = React.useState(false);
  const suppressNextToggleRef = React.useRef(false);
  const menuInstanceKey = `project:${id}`;
  const isMenuOpen = openSidebarMenuKey === menuInstanceKey;
  const hasNewSessionAction = showCreateButtons && Boolean(onNewSession);
  const projectHeaderActionCount = Number(hasNewSessionAction)
    + Number(showCreateButtons && isRepo && !hideWorktreeControls && Boolean(onNewWorktreeSession))
    + Number(!hideProjectAdminControls);

  React.useEffect(() => {
    setImageFailed(false);
  }, [id, projectIconImage?.updatedAt]);

  const ProjectIcon = projectIcon ? PROJECT_ICON_MAP[projectIcon] : null;
  const iconColor = projectColor ? (PROJECT_COLOR_MAP[projectColor] ?? null) : null;
  const imageUrl = !imageFailed
    ? getProjectIconImageUrl({ id, iconImage: projectIconImage }, {
      themeVariant: currentTheme.metadata.variant,
      iconColor: currentTheme.colors.surface.foreground,
    })
    : null;

  const handleMenuOpenChange = React.useCallback((open: boolean) => {
    setOpenSidebarMenuKey(open ? menuInstanceKey : null);
  }, [menuInstanceKey, setOpenSidebarMenuKey]);

  const handleMenuTriggerClick = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  }, []);

  const handleMenuTriggerPointerDown = React.useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  }, []);

  const handleMenuTriggerMouseDown = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  }, []);

  const handleToggleMouseDown = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    if (event.button === 2 || (event.button === 0 && event.ctrlKey)) {
      suppressNextToggleRef.current = true;
    }
  }, []);

  const handleToggleClick = React.useCallback(() => {
    if (suppressNextToggleRef.current) {
      suppressNextToggleRef.current = false;
      return;
    }
    onToggle();
  }, [onToggle]);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('relative', isDragging && 'opacity-30')}
    >
      {!hideHeader ? (
        <>
          {isDesktopShell && (
            <div
              ref={sentinelRef}
              data-project-id={id}
              className="absolute top-0 h-px w-full pointer-events-none"
              aria-hidden="true"
            />
          )}

          <div
            className={cn(
              'w-full text-left group/project select-none',
            )}
            style={{ backgroundColor: isDesktopShell && isStuck ? 'transparent' : undefined }}
          >
            <div
              data-project-header
              data-project-header-action-count={projectHeaderActionCount}
              data-project-header-has-new-session={hasNewSessionAction ? 'true' : undefined}
              className="relative flex items-center gap-1 px-0.5 py-0.5"
              {...attributes}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                    <button
                      type="button"
                      onMouseDown={handleToggleMouseDown}
                      onClick={handleToggleClick}
                      aria-expanded={!isCollapsed}
                      {...listeners}
                      className={cn(
                        'flex-1 min-w-0 flex items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 rounded-md cursor-grab active:cursor-grabbing transition-[padding]',
                        isRepo && !hideWorktreeControls
                          ? (alwaysShowActions ? 'pr-[var(--project-header-action-padding,5rem)]' : 'pr-7 group-hover/project:pr-[var(--project-header-action-padding,5rem)] group-focus-within/project:pr-[var(--project-header-action-padding,5rem)]')
                          : (alwaysShowActions ? 'pr-[var(--project-header-action-padding,3.5rem)]' : 'pr-7 group-hover/project:pr-[var(--project-header-action-padding,3.5rem)] group-focus-within/project:pr-[var(--project-header-action-padding,3.5rem)]'),
                      )}
                    >
                    <span
                      data-project-header-icon
                      className="inline-flex h-[0.91875rem] w-[0.91875rem] flex-shrink-0 items-center justify-center"
                    >
                      {imageUrl ? (
                        <span
                          className="inline-flex h-[0.91875rem] w-[0.91875rem] items-center justify-center overflow-hidden rounded-[3px]"
                          style={projectIconBackground ? { backgroundColor: projectIconBackground } : undefined}
                        >
                          <img
                            src={imageUrl}
                            alt=""
                            className="h-full w-full object-contain"
                            draggable={false}
                            onError={() => setImageFailed(true)}
                          />
                        </span>
                      ) : ProjectIcon ? (
                        <ProjectIcon className="h-[0.91875rem] w-[0.91875rem]" style={iconColor ? { color: iconColor } : undefined} />
                      ) : (
                        <RiFolderLine className="h-[0.91875rem] w-[0.91875rem] text-muted-foreground/80" style={iconColor ? { color: iconColor } : undefined} />
                      )}
                    </span>
                    <span className={cn(
                      'text-[length:calc(var(--text-ui-label)*1.08)] font-normal truncate',
                      isActiveProject ? 'text-foreground' : 'text-foreground group-hover/project:text-foreground',
                    )}>
                      {projectLabel}
                    </span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  {projectDescription}
                </TooltipContent>
              </Tooltip>

              <div className={cn(
                'absolute top-1/2 z-10 flex -translate-y-1/2 items-center gap-1',
                showCreateButtons ? 'right-[var(--project-header-secondary-right,1.75rem)]' : 'right-0.5',
              )}>
                {showCreateButtons && isRepo && !hideWorktreeControls && onNewWorktreeSession ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onNewWorktreeSession();
                        }}
                        className={cn(
                        'inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 hover:text-foreground transition-opacity',
                          alwaysShowActions ? 'opacity-100' : 'opacity-0 pointer-events-none group-hover/project:opacity-100 group-hover/project:pointer-events-auto group-focus-within/project:opacity-100 group-focus-within/project:pointer-events-auto',
                        )}
                        aria-label={t('sessions.sidebar.project.actions.newWorktree')}
                      >
                        <RiNodeTree className="h-4 w-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={4}>
                      <p>{t('sessions.sidebar.project.actions.newWorktreeEllipsis')}</p>
                    </TooltipContent>
                  </Tooltip>
                ) : null}

                {!hideProjectAdminControls ? <DropdownMenu
                  open={isMenuOpen}
                  onOpenChange={handleMenuOpenChange}
                >
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className={cn(
                          'inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 hover:text-foreground',
                          isMenuOpen
                            ? 'opacity-100 pointer-events-auto'
                            : alwaysShowActions
                              ? 'opacity-100'
                              : 'opacity-0 pointer-events-none group-hover/project:opacity-100 group-hover/project:pointer-events-auto group-focus-within/project:opacity-100 group-focus-within/project:pointer-events-auto',
                        )}
                        aria-label={t('sessions.sidebar.project.actions.projectMenu')}
                        onPointerDown={handleMenuTriggerPointerDown}
                        onMouseDown={handleMenuTriggerMouseDown}
                        onClick={handleMenuTriggerClick}
                      >
                        <RiMore2Line className="h-3.5 w-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-[180px]">
                      {showCreateButtons && !isRepo && onNewSession && (
                      <DropdownMenuItem onClick={onNewSession}>
                        <RiAddLine className="mr-1.5 h-4 w-4" />
                        {t('sessions.sidebar.project.actions.newSession')}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onClick={onRenameStart}>
                      <RiPencilAiLine className="mr-1.5 h-4 w-4" />
                      {t('sessions.sidebar.session.menu.rename')}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={onClose}
                      className="text-destructive focus:text-destructive"
                    >
                      <RiCloseLine className="mr-1.5 h-4 w-4" />
                      {t('sessions.sidebar.project.actions.closeProject')}
                    </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu> : null}
              </div>

              {showCreateButtons && onNewSession ? (
                <div className="absolute right-0.5 top-1/2 z-10 -translate-y-1/2">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onNewSession();
                        }}
                        className={cn(
                          'inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 transition-opacity',
                          alwaysShowActions ? 'opacity-100' : 'opacity-0 pointer-events-none group-hover/project:opacity-100 group-hover/project:pointer-events-auto group-focus-within/project:opacity-100 group-focus-within/project:pointer-events-auto',
                        )}
                        aria-label={isRepo
                          ? t('sessions.sidebar.project.actions.newDraftSession')
                          : t('sessions.sidebar.project.actions.newSession')}
                      >
                        <RiAddLine className="h-4 w-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={4}>
                      <p>{isRepo
                        ? t('sessions.sidebar.project.actions.newDraftSession')
                        : t('sessions.sidebar.project.actions.newSession')}</p>
                    </TooltipContent>
                  </Tooltip>
                </div>
              ) : null}
            </div>
          </div>
        </>
      ) : null}

      {children}
    </div>
  );
};

const SortableGroupItemBase: React.FC<{
  id: string;
  disabled?: boolean;
  children: React.ReactNode | ((dragHandleProps: SortableDragHandleProps) => React.ReactNode);
}> = ({ id, disabled = false, children }) => {
  const {
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });

  const dragHandleProps = React.useMemo<SortableDragHandleProps>(() => ({
    listeners,
    setActivatorNodeRef,
  }), [listeners, setActivatorNodeRef]);

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={cn(
        'space-y-0.5 rounded-md',
        isDragging && 'opacity-50',
      )}
    >
      {typeof children === 'function' ? children(dragHandleProps) : children}
    </div>
  );
};

export const SortableGroupItem = React.memo(SortableGroupItemBase);
