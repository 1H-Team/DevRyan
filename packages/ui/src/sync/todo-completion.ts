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

// Only Builder is automatically re-prompted while todos stay open, by
// default-config/plugins/devryan-builder-todo-continuation.mjs. Keep this set
// in step with that plugin's BUILDER_AGENT_NAMES.
const TODO_CONTINUATION_AGENT_NAMES = new Set(["build", "builder"])

const normalizeAgentName = (message: unknown): string => {
  if (message === null || typeof message !== "object") return ""
  const { agent, mode } = message as { agent?: unknown; mode?: unknown }
  const direct = typeof agent === "string" ? agent.trim().toLowerCase() : ""
  if (direct) return direct
  return typeof mode === "string" ? mode.trim().toLowerCase() : ""
}

/** True when a completed assistant response is not final because the runtime
 * will re-prompt its agent for the remaining todos. Other agents may end a turn
 * with blocked todos left open; that turn is still complete. */
export const mayAutoContinueOpenTodos = (
  message: unknown,
  todos: readonly unknown[] | undefined,
): boolean => (
  hasIncompleteTodos(todos) && TODO_CONTINUATION_AGENT_NAMES.has(normalizeAgentName(message))
)
