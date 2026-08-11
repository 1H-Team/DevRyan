# packages/ui/src/components/sections/bug-reports/

## Responsibility

Managed-host Bug Reports settings page for submitting product issues and, for
exact administrators, reviewing reports and sanitized runtime error logs.

## Main files

- `BugReportsPage.tsx`: managed-runtime and role-aware tab shell; each panel is
  lazy and mounts only after its tab is first selected.
- `SubmitBugReportPanel.tsx`: title/description form with client UUID retry
  identity and failure-safe draft handling.
- `BugReportReviewPanel.tsx`: newest-first report list, status filter/cursor,
  detail navigation, and optimistic-concurrency status control.
- `ErrorLogsPanel.tsx`: kind/impact-filtered sanitized diagnostics with tiered
  impact treatment, inferred/recovery status, range-based clear controls,
  agent-context copy, and task-scoped diagnostics export when a session ID
  exists.
- `api.ts`, `types.ts`: browser HTTP client and local response contracts.

## Flow

1. `SettingsView` or `ManagedSettingsView` selects the canonical
   `bug-reports` page.
2. Edit permission enables submission; only `role === "admin"` exposes review
   and error-log tabs.
3. Each admin panel fetches only after activation and owns its own component
   state; no shared Zustand store carries reports or diagnostics.
4. Accessible list buttons open in-page details and Back returns to the
   preserved kind/impact filter state. All impacts is the default; clearing is
   an explicit destructive administrator action scoped to diagnostic rows.

## Integration

- Routes: `/api/bug-reports`, `/api/error-logs`, and existing task diagnostics
  export through `useRuntimeAPIs`.
- Navigation/availability: `lib/settings/{metadata,navigation,permissions}.ts`.
- Server contract: `packages/web/server/lib/multi-user/bug-reports.js`.
