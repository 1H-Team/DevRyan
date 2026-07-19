export type TodoStatusKey = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface TodoSummary<T = unknown> {
    visibleTodos: T[];
    total: number;
    completed: number;
    pending: number;
    inProgress: number;
    active: number;
}

export interface PlanTodoMetadata {
    phase: number;
    title: string;
}

const PLAN_TODO_PREFIX = /^\s*phase\s+(\d+)\s*:\s*(.+)$/i;

export const parsePlanTodoContent = (value: unknown): PlanTodoMetadata | null => {
    if (typeof value !== 'string') return null;
    const match = PLAN_TODO_PREFIX.exec(value);
    if (!match) return null;

    const phase = Number.parseInt(match[1], 10);
    const title = match[2].trim();
    if (!Number.isSafeInteger(phase) || phase < 1 || !title) return null;
    return { phase, title };
};

export const normalizeTodoStatus = (value: unknown): TodoStatusKey | null => {
    if (typeof value !== 'string') {
        return null;
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === 'pending') return 'pending';
    if (normalized === 'in_progress' || normalized === 'in progress' || normalized === 'inprogress') return 'in_progress';
    if (normalized === 'completed' || normalized === 'done') return 'completed';
    if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled';
    return null;
};

export const buildTodoSummary = <T>(todos: readonly T[] | undefined | null): TodoSummary<T> => {
    const visibleTodos: T[] = [];
    let completed = 0;
    let pending = 0;
    let inProgress = 0;

    for (const todo of todos ?? []) {
        if (!todo || typeof todo !== 'object') {
            continue;
        }

        const status = normalizeTodoStatus((todo as { status?: unknown }).status);
        if (!status || status === 'cancelled') {
            continue;
        }

        visibleTodos.push(todo);
        if (status === 'completed') completed += 1;
        if (status === 'pending') pending += 1;
        if (status === 'in_progress') inProgress += 1;
    }

    return {
        visibleTodos,
        total: visibleTodos.length,
        completed,
        pending,
        inProgress,
        active: pending + inProgress,
    };
};

export const getCurrentTodoOrdinal = <T>(
    visibleTodos: readonly T[],
    activeTodo: T | null | undefined,
): number => {
    if (visibleTodos.length === 0) return 0;
    if (!activeTodo) return visibleTodos.length;

    const activeIndex = visibleTodos.indexOf(activeTodo);
    return activeIndex >= 0 ? activeIndex + 1 : visibleTodos.length;
};

export const formatCompactTodoTotal = (total: number): string => {
    const count = Math.max(0, Math.trunc(total));
    return `${count} ${count === 1 ? 'task' : 'tasks'}`;
};
