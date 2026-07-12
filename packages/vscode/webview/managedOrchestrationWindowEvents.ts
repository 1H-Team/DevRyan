const MANAGED_ORCHESTRATION_WINDOW_EVENT_TYPES = new Set([
  'openchamber:managed-task',
  'openchamber:managed-task-removed',
  'openchamber:managed-orchestration-warning',
]);

export const isManagedOrchestrationWindowEventType = (value: unknown): value is string => (
  typeof value === 'string' && MANAGED_ORCHESTRATION_WINDOW_EVENT_TYPES.has(value)
);
