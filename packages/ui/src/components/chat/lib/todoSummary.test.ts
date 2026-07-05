import { describe, expect, test } from 'bun:test';

import { buildTodoSummary, formatCompactTodoTotal } from './todoSummary';

const todo = (
    status: string,
    id: string,
    content = id,
): Record<string, unknown> => ({
    id,
    content,
    status,
    priority: 'medium',
});

describe('todo summary helpers', () => {
    test('formats compact total from all visible tasks, including completed tasks', () => {
        const summary = buildTodoSummary([
            todo('completed', 'task-1'),
            todo('in_progress', 'task-2'),
            todo('pending', 'task-3'),
            todo('pending', 'task-4'),
            todo('pending', 'task-5'),
            todo('pending', 'task-6'),
        ]);

        expect({
            total: summary.total,
            completed: summary.completed,
            inProgress: summary.inProgress,
            pending: summary.pending,
            active: summary.active,
        }).toEqual({
            total: 6,
            completed: 1,
            inProgress: 1,
            pending: 4,
            active: 5,
        });
        expect(formatCompactTodoTotal(summary.total)).toBe('6 tasks');
    });

    test('uses singular task label for one visible task', () => {
        const summary = buildTodoSummary([todo('completed', 'task-1')]);

        expect(summary.total).toBe(1);
        expect(summary.completed).toBe(1);
        expect(formatCompactTodoTotal(summary.total)).toBe('1 task');
    });

    test('ignores cancelled and malformed todo-like values for visible totals', () => {
        const summary = buildTodoSummary([
            todo('pending', 'task-1'),
            todo('cancelled', 'task-2'),
            todo('canceled', 'task-3'),
            { id: 'missing-status', content: 'missing status' },
            null,
            'not a todo',
        ]);

        expect({
            total: summary.total,
            completed: summary.completed,
            inProgress: summary.inProgress,
            pending: summary.pending,
            active: summary.active,
        }).toEqual({
            total: 1,
            completed: 0,
            inProgress: 0,
            pending: 1,
            active: 1,
        });
        expect(summary.visibleTodos).toEqual([todo('pending', 'task-1')]);
    });
});
