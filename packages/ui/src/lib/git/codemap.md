# packages/ui/src/lib/git/

## Responsibility
Git-domain client helpers for status, diffs, and repository operations.

## Design
Thin typed wrappers over server git routes plus formatting/safety helpers for git workflows. `commitPlanContext.ts` collects bounded status, history, and diff context for both direct commit-subject generation and non-mutating plan previews.

## Flow
Views/hooks request git data, then transform results for tables and diff widgets. The Source-tab commit generator uses staged changes when present, otherwise all worktree changes, and passes the bounded context to the host-owned session-free utility-model route.

## Integration
Consumed by git views, session context features, and project settings.
