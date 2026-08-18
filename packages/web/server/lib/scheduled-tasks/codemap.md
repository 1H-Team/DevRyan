# packages/web/server/lib/scheduled-tasks/

## Responsibility
Scheduled automation subsystem for project tasks: schedule computation, runtime orchestration/queueing, manual run triggers, and task status/event APIs.

## Design
- `runtime.js` is core engine: next-run computation (`daily/weekly/once/cron`), concurrency limits, jitter, run lifecycle/state, local plus managed startup discovery, live owner/grant directory resolution, and ownership-before-prompt execution.
- `routes.js` provides assignment-aware, owner-filtered CRUD/run/status endpoints and a principal-filtered SSE channel for OpenChamber events.
- Runtime uses deterministic task keys (`projectID:taskID`) and bounded execution windows.

## Flow
1. Route layer validates IDs/payloads and persists task config via project config runtime.
2. Runtime `syncProject()` recalculates scheduled timers after create/update/delete.
3. Scheduler fires due tasks, resolves an owner-scoped task from the owner’s current branch target (or an ownerless legacy task from local settings), starts an OpenCode session, records ownership, and only then submits the command/prompt.
4. Status endpoints/SSE surface enabled/running counts and lifecycle events to clients.

## Integration
- Depends on settings/project config runtimes and OpenCode SDK client creation for task execution.
- Consumed by UI scheduled-task management screens and background server startup lifecycle.
