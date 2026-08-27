# packages/web/server/lib/scheduled-tasks/

## Responsibility
Scheduled automation subsystem for project tasks: schedule computation, runtime orchestration/queueing, manual run triggers, and task status/event APIs.

## Design
- `runtime.js` is core engine: next-run computation (`daily/weekly/once/cron`), cross-process at-most-once occurrence claims, concurrency limits, jitter, run lifecycle/state, terminal-persistence retry, local plus managed startup discovery, live owner/grant directory resolution, and ownership-before-prompt execution.
- `routes.js` provides assignment-aware, owner-filtered CRUD/run/status
  endpoints, canonicalizes managed administrator local aliases to managed
  project UUIDs, and owns the principal-filtered SSE channel.
- Runtime uses deterministic task keys (`projectID:taskID`), bounded execution
  windows, and authoritative owner/project/branch reconciliation. Definitively
  revoked tasks are deleted atomically; suspended-owner tasks remain dormant;
  unverifiable tasks remain stored but cannot dispatch.

## Flow
1. Route layer validates IDs/payloads and persists task config via project config runtime.
2. Runtime `syncProject()` recalculates scheduled timers after create/update/delete.
3. Scheduler atomically claims the exact due occurrence and advances/consumes its schedule before resolving the live target, starting an OpenCode session, recording ownership, and submitting the command/prompt.
4. Status endpoints/SSE surface enabled/running counts and lifecycle events to clients.
5. Startup, access mutations, and quit-status refresh reconcile persisted tasks
   so hidden orphan records cannot retain timers or inflate desktop quit risk.

## Integration
- Depends on settings/project config runtimes and OpenCode SDK client creation for task execution.
- Consumed by UI scheduled-task management screens and background server startup lifecycle.
