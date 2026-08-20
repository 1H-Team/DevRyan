import React from 'react';
import { RiArrowDownSLine, RiArrowRightSLine } from '@remixicon/react';

import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { TaskToolSummary } from './message/parts/TaskToolSummary';
import type { CursorNativeTaskDispatch } from './cursorNativeTaskDispatch';

const statusPresentation = (
    status: CursorNativeTaskDispatch['status'],
    t: ReturnType<typeof useI18n>['t'],
) => {
    if (status === 'completed') {
        return { label: t('chat.managedTasks.summary.complete'), className: 'text-[var(--status-success)]' };
    }
    if (status === 'error' || status === 'cancelled') {
        return { label: t('chat.managedTasks.summary.error'), className: 'text-[var(--status-error)]' };
    }
    return { label: t('chat.managedTasks.summary.running'), className: 'text-muted-foreground' };
};

const CursorNativeTaskRow = React.memo(({
    task,
    isMobile,
}: {
    task: CursorNativeTaskDispatch;
    isMobile: boolean;
}) => {
    const { t } = useI18n();
    const [expanded, setExpanded] = React.useState(false);
    const status = statusPresentation(task.status, t);
    const detail = [task.agent, task.modelLabel, status.label].filter(Boolean).join(' · ');
    const hasDetails = task.entries.length > 0 || Boolean(task.text) || Boolean(task.output) || Boolean(task.error) || task.stepCount > 0;

    return (
        <article data-cursor-native-task-id={task.callId} data-task-source="cursor-native">
            <button
                type="button"
                className="flex w-full min-w-0 items-start gap-2 px-3 py-2.5 text-left"
                aria-expanded={expanded}
                disabled={!hasDetails}
                onClick={() => setExpanded((current) => !current)}
            >
                <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-muted-foreground" aria-hidden="true">
                    {hasDetails
                        ? expanded
                            ? <RiArrowDownSLine className="size-4" />
                            : <RiArrowRightSLine className="size-4" />
                        : null}
                </span>
                <span className="min-w-0 flex-1">
                    <span className="block line-clamp-2 break-words typography-ui-label font-medium text-foreground sm:line-clamp-1">
                        {task.description}
                    </span>
                    <span className={cn('block truncate typography-meta', status.className)}>
                        {detail}
                    </span>
                </span>
            </button>
            {expanded ? (
                <div className="border-t border-border/60 px-3 pb-2">
                    {task.text ? (
                        <p className="px-[1.4375rem] pt-2 typography-meta text-muted-foreground">
                            {task.text}
                        </p>
                    ) : null}
                    {task.entries.length > 0 || task.output || task.error ? (
                        <TaskToolSummary
                            entries={task.entries}
                            isExpanded
                            isMobile={isMobile}
                            output={task.output}
                            error={task.error}
                            status={task.status}
                            input={{ model: task.model, subagent_type: task.agent }}
                            animateTailText={task.status === 'running'}
                            isActive={task.status === 'running'}
                        />
                    ) : null}
                    {task.stepCount > 0 ? (
                        <p className="pl-[1.4375rem] typography-micro text-muted-foreground">
                            {t('chat.managedTasks.cursorNative.steps', { count: task.stepCount })}
                        </p>
                    ) : null}
                    {task.truncated ? (
                        <p className="pl-[1.4375rem] typography-micro text-muted-foreground">
                            {t('chat.managedTasks.cursorNative.truncated')}
                        </p>
                    ) : null}
                </div>
            ) : null}
        </article>
    );
});

CursorNativeTaskRow.displayName = 'CursorNativeTaskRow';

export const CursorNativeTaskRows = React.memo(({
    tasks,
    isMobile = false,
}: {
    tasks: readonly CursorNativeTaskDispatch[];
    isMobile?: boolean;
}) => (
    <div className="divide-y divide-border/60">
        {tasks.map((task) => <CursorNativeTaskRow key={task.partId} task={task} isMobile={isMobile} />)}
    </div>
));

CursorNativeTaskRows.displayName = 'CursorNativeTaskRows';
