const INCOMPLETE_TODO_STATUSES = new Set(["pending", "in_progress"])

const normalizeTodoStatus = (value: unknown): string => (
  typeof value === "string" ? value.trim().toLowerCase().replaceAll(" ", "_") : ""
)

export const hasIncompleteTodos = (todos: readonly unknown[] | undefined): boolean => (
  Array.isArray(todos) && todos.some((todo) => (
    todo !== null
    && typeof todo === "object"
    && INCOMPLETE_TODO_STATUSES.has(normalizeTodoStatus((todo as { status?: unknown }).status))
  ))
)
