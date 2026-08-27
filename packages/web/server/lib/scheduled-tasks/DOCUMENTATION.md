# Scheduled Tasks module

Server-owned scheduled task runtime and routes for OpenChamber-only automation.

## Scope

- Per-project scheduled task persistence is owned by `packages/web/server/lib/projects/project-config.js`.
- Version 2 task records optionally contain server-controlled `ownerUserId` and `target.branchName`. Ownerless version 1 tasks remain administrator-owned legacy records.
- Runtime orchestration and execution is owned by this module.
- This module is OpenChamber feature logic; it is intentionally separate from OpenCode proxy/runtime internals.
- Owner-scoped tasks resolve their execution directory from the owner's live managed project/branch assignment. Ownerless legacy tasks continue to resolve their project path from local settings.
- Startup synchronization combines local settings projects with active managed project IDs so persisted managed timers survive web/Electron restarts without treating a cached path as authorization.

## Files

- `packages/web/server/lib/scheduled-tasks/runtime.js`
  - Next-run computation (daily/weekly/cron compatibility)
  - Timer scheduling and queueing
  - Atomic per-occurrence claims across server processes before any session or prompt side effect
  - Concurrency controls
  - Session create + prompt_async execution
  - Live owner/grant reload, branch-target preparation, and pre-prompt session ownership registration
  - Active managed-project discovery for restart-safe timer restoration
  - Emits OpenChamber task-run events
  - Persists terminal state with a bounded retry and exposes `persistError` when the durable final write still fails

- `packages/web/server/lib/scheduled-tasks/routes.js`
  - Scheduled task CRUD endpoints
  - Manual run endpoint
  - OpenChamber events SSE stream endpoint
  - Per-principal task/status/event filtering and assignment enforcement
  - Assignment snapshot registration used to scope project-metadata invalidations

## Public exports (runtime.js)

- `createScheduledTasksRuntime(dependencies)`
- Returned API:
  - `start()`
  - `stop()`
  - `syncAllProjects()`
  - `syncProject(projectId)`
  - `runNow(projectId, taskId)`
  - `getStatus()` returns total enabled records separately from pending schedules
    that have a future execution; desktop quit protection uses the pending and
    running counts, so expired one-time records do not block quitting.
  - `refreshStatus()` re-reads projects and authoritatively reconciles each
    owner-scoped task before returning counts. Active owners with a matching
    branch are runnable, suspended owners are retained but dormant, and tasks
    with definitively revoked owner/project/branch access are deleted. Control
    plane failures retain data, suppress dispatch, and return `verified: false`.
  - `removeTasksForRevokedAccess()` applies successful access mutations
    immediately through the project-config lock; startup and status refresh
    recover missed notifications and older orphan records.

Scheduled occurrences carry their exact `scheduledFor` timestamp. Under the
project-config cross-process lock, a claim writes `lastScheduledFor` and either
advances a recurring schedule or consumes a one-time schedule before execution.
Losing processes create no session, emit no run event, and schedule no past-due
timer. Restart after a successful claim therefore preserves at-most-once
semantics for daily, weekly, cron, and once schedules. Manual runs do not claim
or advance scheduled occurrences.

## Public exports (routes.js)

- `registerScheduledTaskRoutes(app, dependencies)`
- Registers:
  - `GET /api/projects/:projectId/scheduled-tasks`
  - `PUT /api/projects/:projectId/scheduled-tasks`
  - `DELETE /api/projects/:projectId/scheduled-tasks/:taskId`
  - `POST /api/projects/:projectId/scheduled-tasks/:taskId/run`
  - `GET /api/openchamber/scheduled-tasks/status`
  - `GET /api/openchamber/events`

The status response preserves `hasEnabledScheduledTasks` and
`enabledScheduledTasksCount` for management compatibility. Quit-risk consumers
must use `hasPendingScheduledTasks` / `pendingScheduledTasksCount` together with
the running-task fields and honor `verified` rather than trusting stale counts.

Managed non-admin users can list, create, edit, delete, and run only their own tasks. Administrators can manage all personal and legacy ownerless tasks. All mutations require the standard CSRF header.
Managed administrators may reach a project through a local-settings alias; the
route resolves that alias by repository path and persists owner-scoped tasks
under the authoritative managed project UUID. Unmatched local projects remain
ownerless local schedules.

The shared OpenChamber event stream also carries `openchamber:project-metadata-changed`
with only a project ID. Administrators receive all such invalidations; managed
non-admin clients receive them only for project IDs present in their assignment snapshot.
