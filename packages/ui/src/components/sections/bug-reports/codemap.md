# packages/ui/src/components/sections/bug-reports/

## Responsibility

Managed-host Bug Reports settings page for submitting product issues and, for
exact administrators, reviewing reports, agent diagnostics, and the reserved
Bot Audit surface.

## Main files

- `BugReportsPage.tsx`: managed-runtime and role-aware four-tab shell; each
  panel is lazy and mounts only after its tab is first selected.
- `SubmitBugReportPanel.tsx`: title/description form with client UUID retry
  identity and failure-safe draft handling.
- `BugReportReviewPanel.tsx`: newest-first report list, status filter/cursor,
  detail navigation, and optimistic-concurrency status control.
- `ErrorLogsPanel.tsx`: disposition/kind/impact-filtered sanitized diagnostics
  with Actionable as the default, Expected and All alternatives, tiered impact
  treatment, inferred/recovery status, range-based clear controls, agent-context
  copy, and task-scoped diagnostics export when a session ID exists.
- `BotAuditPanel.tsx`: presentation-only placeholder for future Bot Audit logs;
  it has no data contract, requests, filters, or management controls.
- `api.ts`, `types.ts`: browser HTTP client and local response contracts.

## Flow

1. `SettingsView` or `ManagedSettingsView` selects the canonical
   `bug-reports` page.
2. Edit permission enables submission; only `role === "admin"` exposes report,
   Agent Audit, and Bot Audit tabs.
3. Each admin panel mounts only after activation. Data-backed panels own their
   component state; no shared Zustand store carries reports or diagnostics.
4. Agent Audit continues to use the existing `/api/error-logs` contract. Bot
   Audit is a static informational empty state until bot logging is designed.
5. Accessible list buttons open in-page details and Back returns to the
   preserved disposition/kind/impact filter state. Actionable and All Impacts
   are the defaults; clearing is an explicit destructive administrator action
   scoped to diagnostic rows. Direct UUID details remain visible regardless of
   the current disposition filter.

## Integration

- Routes: `/api/bug-reports`, `/api/error-logs`, and existing task diagnostics
  export through `useRuntimeAPIs`.
- Navigation/availability: `lib/settings/{metadata,navigation,permissions}.ts`.
- Server contract: `packages/web/server/lib/multi-user/bug-reports.js`.
