import { describe, expect, test } from 'bun:test';

import {
    buildPlanPhaseTodoProjection,
    buildTodoSummary,
    formatCompactTodoTotal,
    getCurrentTodoPosition,
    parsePlanTodoContent,
} from './todoSummary';

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
    test('parses the saved-plan phase prefix used by Builder todos', () => {
        expect(parsePlanTodoContent('Phase 2: Wire task progress to the plan')).toEqual({
            phase: 2,
            title: 'Wire task progress to the plan',
        });
        expect(parsePlanTodoContent('phase 12: Run verification')).toEqual({
            phase: 12,
            title: 'Run verification',
        });
    });

    test('does not infer phases from ordinary non-plan task titles', () => {
        expect(parsePlanTodoContent('Implement phase 2 behavior')).toBeNull();
        expect(parsePlanTodoContent('Phase two: Implement behavior')).toBeNull();
        expect(parsePlanTodoContent('Phase 0: Invalid phase')).toBeNull();
        expect(parsePlanTodoContent('Phase 2:')).toBeNull();
    });

    test('projects only the active phase with stripped titles and phase-local progress', () => {
        const todos = [
            todo('completed', 'phase-1-task-1', 'Phase 1: Inspect the public API'),
            todo('in_progress', 'phase-1-task-2', 'Phase 1: Inspect error coverage'),
            todo('pending', 'phase-2-task-1', 'Phase 2: Run the test suite'),
            todo('pending', 'phase-2-task-2', 'Phase 2: Run the smoke check'),
        ];
        const snapshot = todos.map((item) => ({ ...item }));

        const projection = buildPlanPhaseTodoProjection(todos);

        expect(projection).toEqual({
            phase: 1,
            items: [
                { todo: todos[0], title: 'Inspect the public API' },
                { todo: todos[1], title: 'Inspect error coverage' },
            ],
            current: 2,
            total: 2,
            completed: 1,
        });
        expect(todos).toEqual(snapshot);
        expect(projection?.items[0]?.todo).toBe(todos[0]);
        expect(projection?.items[1]?.todo).toBe(todos[1]);
    });

    test('advances to the next phase when its first task becomes active', () => {
        const todos = [
            todo('completed', 'phase-1-task-1', 'Phase 1: Inspect the public API'),
            todo('completed', 'phase-1-task-2', 'Phase 1: Inspect error coverage'),
            todo('in_progress', 'phase-2-task-1', 'Phase 2: Run the test suite'),
            todo('pending', 'phase-2-task-2', 'Phase 2: Run the smoke check'),
        ];

        expect(buildPlanPhaseTodoProjection(todos)).toEqual({
            phase: 2,
            items: [
                { todo: todos[2], title: 'Run the test suite' },
                { todo: todos[3], title: 'Run the smoke check' },
            ],
            current: 1,
            total: 2,
            completed: 0,
        });
    });

    test('shows the final phase at N/N after every plan task completes', () => {
        const todos = [
            todo('completed', 'phase-1-task-1', 'Phase 1: Inspect the public API'),
            todo('completed', 'phase-1-task-2', 'Phase 1: Inspect error coverage'),
            todo('completed', 'phase-2-task-1', 'Phase 2: Run the test suite'),
            todo('completed', 'phase-2-task-2', 'Phase 2: Run the smoke check'),
        ];

        expect(buildPlanPhaseTodoProjection(todos)).toEqual({
            phase: 2,
            items: [
                { todo: todos[2], title: 'Run the test suite' },
                { todo: todos[3], title: 'Run the smoke check' },
            ],
            current: 2,
            total: 2,
            completed: 2,
        });
    });

    test('falls back when any visible task does not follow the plan prefix contract', () => {
        const mixedTodos = [
            todo('in_progress', 'phase-task', 'Phase 1: Inspect the public API'),
            todo('pending', 'ordinary-task', 'Run the test suite'),
        ];

        expect(buildPlanPhaseTodoProjection(mixedTodos)).toBeNull();
        expect(buildPlanPhaseTodoProjection([
            todo('pending', 'ordinary-task', 'Run the test suite'),
        ])).toBeNull();
    });

    test('uses a one-based position for the first pending or in-progress task', () => {
        const pendingSummary = buildTodoSummary([
            todo('pending', 'task-1'),
            todo('pending', 'task-2'),
        ]);
        const inProgressSummary = buildTodoSummary([
            todo('in_progress', 'task-1'),
            todo('pending', 'task-2'),
        ]);

        expect(getCurrentTodoPosition(pendingSummary.visibleTodos)).toBe(1);
        expect(getCurrentTodoPosition(inProgressSummary.visibleTodos)).toBe(1);
    });

    test('uses the active task ordinal after completed predecessors', () => {
        const summary = buildTodoSummary([
            todo('completed', 'task-1'),
            todo('completed', 'task-2'),
            todo('in_progress', 'task-3'),
            todo('pending', 'task-4'),
        ]);

        expect(getCurrentTodoPosition(summary.visibleTodos)).toBe(3);
    });

    test('uses the final position when every visible task is completed', () => {
        const summary = buildTodoSummary([
            todo('completed', 'task-1'),
            todo('completed', 'task-2'),
        ]);

        expect(getCurrentTodoPosition(summary.visibleTodos)).toBe(2);
    });

    test('excludes cancelled tasks from the current position and total', () => {
        const summary = buildTodoSummary([
            todo('completed', 'task-1'),
            todo('cancelled', 'task-2'),
            todo('pending', 'task-3'),
        ]);

        expect(summary.total).toBe(2);
        expect(getCurrentTodoPosition(summary.visibleTodos)).toBe(2);
    });

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
