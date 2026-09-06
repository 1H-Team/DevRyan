# packages/ui/src/lib/git/

## Responsibility
Git-domain client helpers for status, diffs, and repository operations.

## Design
Thin typed wrappers over server git routes plus formatting/safety helpers for git workflows. `commitPlanContext.ts` collects bounded status, history, and diff context for non-mutating multi-commit plan previews. The sparkles draft path sends only the selected paths, staging mode, and optional guidance to the host-owned draft contract.

## Flow
Views/hooks request git data, then transform results for tables and diff widgets. The Source-tab commit generator uses staged changes when present, otherwise all worktree changes, and makes one host request. Web/Electron collect authoritative context and run the session-free utility model without client-side Git-request fan-out.

## Integration
Consumed by git views, session context features, and project settings.
