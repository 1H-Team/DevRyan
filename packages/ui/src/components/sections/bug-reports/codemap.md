# packages/ui/src/components/sections/bug-reports/

## Responsibility

Managed-host Bug Reports settings page for submitting product issues and, for
exact administrators, reviewing reports, agent diagnostics, and the reserved
Bot Audit ledger.

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
- `BotAuditPanel.tsx`: issues-first Bot audit review list with debounced
  search, result/Bot/user/date/page filters, cursor paging, direct UUID detail,
  validated metadata, audited Bot-context copy, and confirmed range-based clear
  controls. Clearing hides reviewed events for all administrators while retaining
  immutable audit records and UUID detail access. It has no task-export control.
- `api.ts`, `types.ts`: browser HTTP client and local response contracts.

## Flow

1. `SettingsView` or `ManagedSettingsView` selects the canonical
   `bug-reports` page.
2. Edit permission enables submission; only `role === "admin"` exposes report,
   Agent Audit, and Bot Audit tabs.
3. Each admin panel mounts only after activation. Data-backed panels own their
   component state; no shared Zustand store carries reports or diagnostics.
4. Agent Audit continues to use `/api/error-logs`; Bot Audit uses
   `/api/bot-audit` plus `/api/bot-audit/options` and reuses `/api/admin/users`
   for actor options.
5. Accessible list buttons open in-page details and Back preserves loaded rows
   and filters. Agent Audit defaults to Actionable; Bot Audit defaults to
   Issues (`failure | partial | unknown`). Direct UUID details are independent
   of the current list filters.

## Integration

- Routes: `/api/bug-reports`, `/api/error-logs`, `/api/bot-audit`, and existing
  task diagnostics export through `useRuntimeAPIs`.
- Navigation/availability: `lib/settings/{metadata,navigation,permissions}.ts`.
- Server contracts: `packages/web/server/lib/multi-user/bug-reports.js` and
  `packages/web/server/lib/bots/audit-query.js`.
