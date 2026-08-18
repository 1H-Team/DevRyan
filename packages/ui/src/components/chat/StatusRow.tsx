import React from "react";
import { useSessionUIStore } from '@/sync/session-ui-store';
import {
  RiArrowDownSLine,
  RiArrowUpDoubleLine,
  RiArrowUpSLine,
  RiCheckboxCircleLine,
  RiCloseCircleLine,
  RiDraftLine,
  RiErrorWarningLine,
  RiRecordCircleLine,
  RiTimeLine,
} from "@remixicon/react";
import { cn } from "@/lib/utils";
import { useDirectorySync } from "@/sync/sync-context";
import type { Todo } from "@opencode-ai/sdk/v2/client";

// Compat aliases for old TodoItem shape
type TodoItem = Todo & { id?: string };
type TodoStatus = string;
type TodoPriority = string;
import { useUIStore } from "@/stores/useUIStore";
import { useTodosPersistStore } from "@/stores/useTodosPersistStore";
import { WorkingPlaceholder } from "./message/parts/WorkingPlaceholder";
import { isVSCodeRuntime } from "@/lib/desktop";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useI18n } from "@/lib/i18n";
import {
  buildPlanPhaseTodoProjection,
  buildTodoSummary,
  getCurrentTodoPosition,
} from "./lib/todoSummary";
import { useSessionPlanFileStore } from '@/stores/useSessionPlanFileStore';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import {
  getPlanAutoRevealTarget,
  getStatusRowPlanActionState,
  hasPlanTaskTrackingContext,
  shouldAutoRevealPlanInMainTab,
} from './statusRowPlanAction';
import { preloadPlanView } from '@/components/views/planViewLoader';

const STATUS_ROW_CONTAINER_STYLE = { containerType: "inline-size" as const, containerName: "status-row" };

const statusConfig: Record<TodoStatus, { textClassName: string }> = {
  in_progress: {
    textClassName: "text-foreground",
  },
  pending: {
    textClassName: "text-foreground",
  },
  completed: {
    textClassName: "text-muted-foreground line-through",
  },
  cancelled: {
    textClassName: "text-muted-foreground line-through",
  },
};

const priorityClassName: Record<TodoPriority, string> = {
  high: "text-[var(--status-warning)]",
  medium: "text-muted-foreground",
  low: "text-muted-foreground/70",
};

const priorityIcon: Record<TodoPriority, React.ReactNode> = {
  high: <RiArrowUpDoubleLine className="h-3.5 w-3.5" aria-hidden="true" />,
  medium: <RiArrowUpSLine className="h-3.5 w-3.5" aria-hidden="true" />,
  low: <RiArrowDownSLine className="h-3.5 w-3.5" aria-hidden="true" />,
};

const statusLabelKey: Record<TodoStatus, string> = {
  in_progress: "chat.statusRow.todo.status.inProgress",
  pending: "chat.statusRow.todo.status.pending",
  completed: "chat.statusRow.todo.status.completed",
  cancelled: "chat.statusRow.todo.status.cancelled",
};

const priorityLabelKey: Record<TodoPriority, string> = {
  high: "chat.statusRow.todo.priority.high",
  medium: "chat.statusRow.todo.priority.medium",
  low: "chat.statusRow.todo.priority.low",
};

interface TodoItemRowProps {
  todo: TodoItem;
  displayContent?: string;
}

const TodoItemRow: React.FC<TodoItemRowProps> = ({ todo, displayContent }) => {
  const { t } = useI18n();
  const config = statusConfig[todo.status] || statusConfig.pending;
  const statusKey = statusLabelKey[todo.status] ?? statusLabelKey.pending;
  const priorityKey = priorityLabelKey[todo.priority] ?? priorityLabelKey.medium;

  const statusIcon =
    todo.status === "in_progress" ? (
      <RiRecordCircleLine className="h-3.5 w-3.5 text-[var(--status-info)]" aria-hidden="true" />
    ) : todo.status === "completed" ? (
      <RiCheckboxCircleLine className="h-3.5 w-3.5 text-[var(--status-success)]" aria-hidden="true" />
    ) : (
      <RiTimeLine className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
    );

  return (
    <div className="flex items-center min-w-0 py-0.5 gap-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex-shrink-0">{statusIcon}</span>
        </TooltipTrigger>
        <TooltipContent side="left" sideOffset={6}>
          {t(statusKey as never)}
        </TooltipContent>
      </Tooltip>
      <span
        className={cn(
          "flex-1 typography-ui-label",
          config.textClassName
        )}
      >
        {displayContent ?? todo.content}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "typography-meta flex items-center justify-center flex-shrink-0 leading-none",
              priorityClassName[todo.priority] ?? priorityClassName.medium
            )}
          >
            {priorityIcon[todo.priority] ?? priorityIcon.medium}
          </span>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={6}>
          {t(priorityKey as never)}
        </TooltipContent>
      </Tooltip>
    </div>
  );
};

const EMPTY_TODOS: TodoItem[] = [];

interface StatusRowProps {
  // Working state
  isWorking?: boolean;
  statusText?: string | null;
  isGenericStatus?: boolean;
  isWaitingForPermission?: boolean;
  wasAborted?: boolean;
  abortActive?: boolean;
  retryInfo?: { attempt?: number; next?: number } | null;
  providerStallStatusText?: string | null;
  providerStallPending?: boolean;
  providerStallError?: string | null;
  onResolveProviderStall?: () => void;
  longRunningToolStatusText?: string | null;
  longRunningToolPending?: boolean;
  longRunningToolError?: string | null;
  onStopLongRunningTool?: () => void;
  // Abort state (for mobile/vscode)
  showAbort?: boolean;
  onAbort?: () => void;
  // Abort status display
  showAbortStatus?: boolean;
  showAssistantStatus?: boolean;
  showTodos?: boolean;
  agentName?: string;
  leftAccessory?: React.ReactNode;
  // When set, renders the task/plan row as the tucked-behind-card "tab" bar
  // (matching the draft project/branch bar) with tasks left and Plan right.
  tabBackground?: string;
  // When true, hide the tucked tab without unmounting so plan auto-reveal /
  // preload effects keep running. ChatInput sets this while messages are queued.
  suppressTab?: boolean;
}

export const StatusRow: React.FC<StatusRowProps> = ({
  isWorking = false,
  statusText = null,
  isGenericStatus,
  isWaitingForPermission,
  wasAborted,
  abortActive,
  retryInfo,
  providerStallStatusText,
  providerStallPending,
  providerStallError,
  onResolveProviderStall,
  longRunningToolStatusText,
  longRunningToolPending,
  longRunningToolError,
  onStopLongRunningTool,
  showAbort,
  onAbort,
  showAbortStatus,
  showAssistantStatus = true,
  showTodos = true,
  agentName,
  leftAccessory,
  tabBackground,
  suppressTab,
}) => {
  const { t } = useI18n();
  const isTab = Boolean(tabBackground);
  const [isExpanded, setIsExpanded] = React.useState(false);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const isSessionPlanAvailable = useSessionUIStore((state) => (
    currentSessionId ? state.sessionPlanAvailable.get(currentSessionId) === true : false
  ));
  const sessionPlanIndicator = useSessionUIStore((state) => (
    currentSessionId ? state.sessionPlanIndicator.get(currentSessionId) : undefined
  ));
  const sessionPlanRecord = useSessionPlanFileStore((state) => (
    currentSessionId ? state.recordsBySession[currentSessionId] : undefined
  ));
  const claimPlanAutoReveal = useSessionPlanFileStore((state) => state.claimAutoReveal);
  const todosRecord = useDirectorySync((state) => state.todo);
  const persistedSessionTodos = useTodosPersistStore(
    React.useCallback(
      (state) => (currentSessionId ? state.sessions[currentSessionId]?.todos : undefined),
      [currentSessionId],
    ),
  );
  const todos: TodoItem[] = React.useMemo(() => {
    if (!currentSessionId) return EMPTY_TODOS;
    const live = todosRecord[currentSessionId];
    if (live && live.length > 0) return live;
    return persistedSessionTodos ?? EMPTY_TODOS;
  }, [todosRecord, persistedSessionTodos, currentSessionId]);
  const isMobile = useUIStore((state) => state.isMobile);
  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const toggleContextPlan = useUIStore((state) => state.toggleContextPlan);
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const isVSCode = isVSCodeRuntime();
  const isCompact = isMobile || isVSCode;
  const shouldAutoRevealPlan = shouldAutoRevealPlanInMainTab({ isMobile, isVSCode });
  const planActionState = getStatusRowPlanActionState({
    showTodos,
    isPlanAvailable: isSessionPlanAvailable,
    isVSCode,
    record: sessionPlanRecord,
  });
  const hasPlanTaskContext = hasPlanTaskTrackingContext({
    isPlanAvailable: isSessionPlanAvailable,
    record: sessionPlanRecord,
  });

  React.useEffect(() => {
    if (!planActionState.enabled) return;
    void preloadPlanView().catch(() => undefined);
  }, [planActionState.enabled]);

  React.useEffect(() => {
    if (!suppressTab) return;
    setIsExpanded(false);
  }, [suppressTab]);

  React.useEffect(() => {
    if (!shouldAutoRevealPlan) return;

    const isPlanSourceImplemented = currentSessionId && sessionPlanRecord
      ? useSessionUIStore.getState().isPlanSourceImplemented(
          currentSessionId,
          sessionPlanRecord.sourceMessageId,
        )
      : false;
    const target = getPlanAutoRevealTarget({
      sessionId: currentSessionId,
      isPlanAvailable: isSessionPlanAvailable,
      planIndicator: sessionPlanIndicator,
      isPlanSourceImplemented,
      record: sessionPlanRecord,
    });
    if (!target) return;
    if (!claimPlanAutoReveal(target.sessionId, target.sourceMessageId)) return;

    void preloadPlanView().catch(() => undefined);
    setActiveMainTab('plan');
  }, [
    claimPlanAutoReveal,
    currentSessionId,
    isSessionPlanAvailable,
    sessionPlanIndicator,
    sessionPlanRecord,
    setActiveMainTab,
    shouldAutoRevealPlan,
  ]);

  const todoSummary = React.useMemo(() => buildTodoSummary(todos), [todos]);
  const visibleTodos = todoSummary.visibleTodos;

  // Find the current active todo (first in_progress, or first pending)
  const activeTodo = React.useMemo(() => {
    return (
      visibleTodos.find((t) => t.status === "in_progress") ||
      visibleTodos.find((t) => t.status === "pending") ||
      null
    );
  }, [visibleTodos]);

  const planPhaseProjection = React.useMemo(() => (
    hasPlanTaskContext ? buildPlanPhaseTodoProjection(visibleTodos) : null
  ), [hasPlanTaskContext, visibleTodos]);

  // Calculate progress. Saved-plan progress is scoped to the active phase;
  // malformed or ordinary todo lists retain the existing whole-list summary.
  const progress = React.useMemo(() => ({
    completed: planPhaseProjection?.completed ?? todoSummary.completed,
    total: planPhaseProjection?.total ?? todoSummary.total,
  }), [planPhaseProjection, todoSummary.completed, todoSummary.total]);

  const hasTodoContent = showTodos && progress.total > 0;
  const hasAssistantContent = showAssistantStatus && (
    isWorking ||
    Boolean(wasAborted) ||
    Boolean(showAbortStatus) ||
    Boolean(providerStallStatusText) ||
    Boolean(longRunningToolStatusText)
  );
  const hasLeftAccessory = Boolean(leftAccessory);
  // Original logic from ChatInput
  const shouldRenderPlaceholder = !showAbortStatus && (wasAborted || !abortActive);

  const hasContent = hasAssistantContent || hasTodoContent || hasLeftAccessory || planActionState.visible;
  // Compact surfaces still show the active task: the counter is short, and the
  // task text truncates before it can crowd out progress or the chevron.
  const todoTitle = planPhaseProjection
    ? t('chat.statusRow.planTaskTitle', { phase: planPhaseProjection.phase })
    : activeTodo?.content ?? t('chat.statusRow.tasksTitle');
  const displayedProgress = planPhaseProjection
    ? planPhaseProjection.current
    : getCurrentTodoPosition(visibleTodos);

  // Close popover when clicking outside
  const popoverRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!isExpanded) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        setIsExpanded(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isExpanded]);

  const toggleExpanded = () => setIsExpanded((prev) => !prev);
  const todoSummaryLabel = t('chat.statusRow.summary.progress', {
    task: todoTitle,
    completed: displayedProgress,
    total: progress.total,
  });
  // Saved-plan phases keep their "Phase n: Task x/y" wording; ordinary todos use
  // the leading "Task n/N: <summary>" form requested for the left of the tab bar.
  const compactTaskLabel = planPhaseProjection
    ? `${todoTitle} ${displayedProgress}/${progress.total}`
    : t('chat.statusRow.summary.taskLabel', {
        completed: displayedProgress,
        total: progress.total,
        task: todoTitle,
      });

  // Abort button for mobile/vscode
  const abortButton = showAbort && onAbort ? (
    <button
      type="button"
      onClick={onAbort}
      className="flex items-center justify-center h-[1.2rem] w-[1.2rem] text-[var(--status-error)] transition-opacity hover:opacity-80 focus-visible:outline-none flex-shrink-0"
      aria-label={t('chat.statusRow.actions.stopGeneratingAria')}
    >
      <RiCloseCircleLine size={18} aria-hidden="true" />
    </button>
  ) : null;

  // Todo trigger button
  const todoTrigger = hasTodoContent ? (
    <button
      type="button"
      onClick={toggleExpanded}
      className={cn(
        "flex items-center gap-1 text-muted-foreground",
        isTab ? "min-w-0" : "min-w-0 max-w-full flex-shrink-0",
      )}
      aria-label={todoSummaryLabel}
      title={todoSummaryLabel}
    >
      <span
        className={cn(
          "typography-ui-label text-foreground truncate min-w-0",
          isTab
            ? (isExpanded
              ? "max-w-[calc(100cqw-2.25rem)]"
              : "max-w-[min(69cqw,calc(100cqw-6.5rem))]")
            : "status-row__active-todo max-w-[200px]",
          !isTab && isCompact && "max-w-[38cqw]",
        )}
      >
        {compactTaskLabel}
      </span>
      <RiArrowUpSLine
        className={cn(
          "h-3.5 w-3.5 flex-shrink-0",
          isTab && "transition-transform duration-200 ease-in-out",
          isTab && isExpanded && "rotate-180",
        )}
        aria-hidden="true"
      />
    </button>
  ) : null;

  const handleViewPlan = React.useCallback(() => {
    if (!planActionState.enabled || !sessionPlanRecord?.path) return;
    if (isMobile) {
      setActiveMainTab('plan');
      return;
    }
    if (!effectiveDirectory) return;
    toggleContextPlan(effectiveDirectory, sessionPlanRecord.path, currentSessionId);
  }, [currentSessionId, effectiveDirectory, isMobile, planActionState.enabled, sessionPlanRecord?.path, setActiveMainTab, toggleContextPlan]);

  const viewPlanButton = planActionState.visible ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="shrink-0" tabIndex={planActionState.enabled ? undefined : 0}>
          <button
            type="button"
            className="typography-ui-label shrink-0 inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!planActionState.enabled}
            aria-label={t('chat.statusRow.actions.viewPlan')}
            onClick={handleViewPlan}
          >
            <RiDraftLine className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {t('chat.statusRow.actions.viewPlan')}
          </button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {planActionState.disabledReason ?? t('chat.statusRow.actions.viewPlanTooltip')}
      </TooltipContent>
    </Tooltip>
  ) : null;
  const resolveProviderStallButton = providerStallStatusText && onResolveProviderStall ? (
    <button
      type="button"
      className="typography-ui-label shrink-0 text-[var(--status-warning)] transition-opacity hover:opacity-80 disabled:cursor-wait disabled:opacity-50"
      disabled={providerStallPending}
      onClick={onResolveProviderStall}
      aria-label={t('chat.statusRow.providerStall.actionAria')}
    >
      {providerStallPending
        ? t('chat.statusRow.providerStall.stopping')
        : t('chat.statusRow.providerStall.action')}
    </button>
  ) : null;
  const stopLongRunningToolButton = longRunningToolStatusText && onStopLongRunningTool ? (
    <button
      type="button"
      className="typography-ui-label shrink-0 text-[var(--status-warning)] transition-opacity hover:opacity-80 disabled:cursor-wait disabled:opacity-50"
      disabled={longRunningToolPending}
      onClick={onStopLongRunningTool}
      aria-label={t('chat.statusRow.longRunningTool.actionAria')}
    >
      {longRunningToolPending
        ? t('chat.statusRow.longRunningTool.stopping')
        : t('chat.statusRow.longRunningTool.action')}
    </button>
  ) : null;

  // Todo rows shared by both layouts.
  const todoListRows = planPhaseProjection
    ? planPhaseProjection.items.map(({ todo, title }, index) => (
      <TodoItemRow
        key={todo.id ?? `plan-todo-${index}`}
        todo={todo}
        displayContent={title}
      />
    ))
    : visibleTodos.map((todo, index) => (
      <TodoItemRow key={todo.id ?? `todo-${index}`} todo={todo} />
    ));

  // Popover dropdown for the non-tab layout; anchors right of the trigger.
  const popover = !isTab && isExpanded && hasTodoContent ? (
    <div
      style={{
        maxWidth: "min(28rem, calc(100cqw - 4ch))",
        backgroundColor: "var(--surface-elevated)",
        color: "var(--surface-elevated-foreground)",
      }}
      className={cn(
        "absolute bottom-full mb-1 z-50",
        isTab ? "left-0" : "right-0",
        "w-max min-w-[200px] rounded-xl p-1",
        "shadow-[inset_0_1px_0_0_rgba(255,255,255,0.8),inset_0_0_0_1px_rgba(0,0,0,0.04),0_0_0_1px_rgba(0,0,0,0.10),0_1px_2px_-0.5px_rgba(0,0,0,0.08),0_4px_8px_-2px_rgba(0,0,0,0.08),0_12px_20px_-4px_rgba(0,0,0,0.08)]",
        "dark:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12),inset_0_0_0_1px_rgba(255,255,255,0.08),0_0_0_1px_rgba(0,0,0,0.36),0_1px_1px_-0.5px_rgba(0,0,0,0.22),0_3px_3px_-1.5px_rgba(0,0,0,0.20),0_6px_6px_-3px_rgba(0,0,0,0.16)]",
        "animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2",
        "duration-150"
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-1.5 px-2 py-1 typography-ui-label font-medium text-muted-foreground">
        <span>{planPhaseProjection ? todoTitle : t('chat.statusRow.tasksTitle')}</span>
        <span className="typography-meta tabular-nums">
          {displayedProgress}/{progress.total}
        </span>
      </div>

      {/* Todo list */}
      <div className="px-1 max-h-[200px] overflow-y-auto">
        {todoListRows}
      </div>
    </div>
  ) : null;

  // Don't render if nothing to show. Suppressing the tab (rather than
  // unmounting the component) keeps plan auto-reveal / preload effects running.
  if (!hasContent || suppressTab) {
    return null;
  }

  // Tab layout: tucked-behind-card bar (matches the draft project/branch bar)
  // with the task summary on the left and the Plan action on the right. The
  // Plan action hides while the task list is expanded.
  if (isTab) {
    return (
      <div
        className="relative -mb-3 mx-6 flex min-w-0 flex-col rounded-t-xl px-2 pt-1 pb-3"
        style={{ backgroundColor: tabBackground, ...STATUS_ROW_CONTAINER_STYLE }}
        ref={popoverRef}
      >
        <div className="flex min-w-0 items-center justify-between gap-2">
          {/* Left: task summary toggles the inline list below */}
          <div className="flex min-w-0 items-center">
            {todoTrigger}
          </div>
          {/* Right: Plan action (hidden while the task list is expanded) */}
          {!isExpanded ? (
            <div className="flex items-center gap-2 flex-shrink-0">
              {viewPlanButton}
            </div>
          ) : null}
        </div>
        {/* Inline expandable task list: the tab container grows/shrinks with a
            smooth grid-rows transition (mirrors the plan window's 200ms ease). */}
        {hasTodoContent ? (
          <div
            className={cn(
              "grid min-w-0 transition-[grid-template-rows] duration-200 ease-in-out",
              isExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
            )}
            aria-hidden={!isExpanded}
            {...(!isExpanded ? { inert: true } : {})}
          >
            <div className="min-h-0 overflow-hidden">
              <div className="max-h-[200px] overflow-y-auto px-1 pb-0.5 pt-1">
                {todoListRows}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className={cn("mb-1", !hasLeftAccessory && "chat-column")} style={STATUS_ROW_CONTAINER_STYLE}>
      <div className={cn("flex items-center justify-between py-0.5 gap-2 h-[1.2rem]", hasLeftAccessory && "px-0.5")}>
        {/* Left: Abort status or Working placeholder or leftAccessory */}
        <div className={cn("flex-1 flex items-center min-w-0", hasLeftAccessory ? "pl-1.5" : "overflow-hidden")}>
          {showAssistantStatus && showAbortStatus ? (
            <div className="flex h-full items-center text-[var(--status-error)] pl-0.5">
              <span className="flex items-center gap-1.5 typography-ui-label">
                <RiCloseCircleLine size={16} aria-hidden="true" />
                {t('chat.statusRow.aborted')}
              </span>
            </div>
          ) : providerStallStatusText ? (
            <div
              className={cn(
                "flex min-w-0 items-center gap-1.5 pl-0.5 typography-ui-label",
                providerStallError ? "text-[var(--status-error)]" : "text-[var(--status-warning)]",
              )}
              title={providerStallError ?? providerStallStatusText}
            >
              <RiErrorWarningLine size={16} className="shrink-0" aria-hidden="true" />
              <span className="truncate">{providerStallError ?? providerStallStatusText}</span>
            </div>
          ) : longRunningToolStatusText ? (
            <div
              className={cn(
                "flex min-w-0 items-center gap-1.5 pl-0.5 typography-ui-label",
                longRunningToolError ? "text-[var(--status-error)]" : "text-[var(--status-warning)]",
              )}
              title={longRunningToolError ?? longRunningToolStatusText}
            >
              <RiErrorWarningLine size={16} className="shrink-0" aria-hidden="true" />
              <span className="truncate">{longRunningToolError ?? longRunningToolStatusText}</span>
            </div>
          ) : showAssistantStatus && shouldRenderPlaceholder ? (
            <WorkingPlaceholder
              key={currentSessionId ?? "no-session"}
              isWorking={isWorking}
              statusText={statusText}
              isGenericStatus={isGenericStatus}
              isWaitingForPermission={isWaitingForPermission}
              retryInfo={retryInfo}
              agentName={agentName}
            />
          ) : leftAccessory ? (
            leftAccessory
          ) : null}
        </div>

        {/* Right: Abort (mobile only) + Todo + View Plan */}
        <div className={cn("relative flex items-center gap-2 flex-shrink-0", hasLeftAccessory ? "pr-1.5" : "-mr-3")} ref={popoverRef}>
          {abortButton}
          {resolveProviderStallButton}
          {stopLongRunningToolButton}
          {todoTrigger}
          {viewPlanButton}

          {/* Popover dropdown */}
          {popover}
        </div>
      </div>
    </div>
  );
};
