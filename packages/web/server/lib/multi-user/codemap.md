# packages/web/server/lib/multi-user/

## Responsibility

Server-only multi-user identity, policy, project/branch assignment, session
ownership, directory opacity, and audit control plane.

## Main files

- `runtime.js`: composition root, auth/session lifecycle, HTTP/SSE/WS policy,
  administration routes (including the token-free GitHub account inventory,
  atomic owner reassignment, and managed-project register/unregister), exclusive
  profile/account assignments, ownership, and live revocation.
- `auth-compat.js`: canonical-to-legacy user-policy read compatibility,
  structured identity/schema errors, fail-closed Production Bots migration
  detection, and loopback agent-test fixture selection.
- `user-profile-visibility.js`: authoritative account-kind constants and the
  human-only profile query used by User Management.
- `config.js`, `supabase-client.js`, `vault.js`: private configuration,
  server-only Supabase/PostgREST plus bounded private Storage transport, and
  encrypted token persistence. `runtime.js` injects that transport into the
  focused sibling `../bots/` control-plane module.
- `policy.js`: exact role templates, canonical settings Read/Edit permissions,
  sparse per-user overrides (including default-on Bots access and the
  developer-default hidden Global Agent Behavior UI), route/field ownership,
  and capability evaluation. Generic personal settings saves are authorized by
  each changed field's owner rather than a coarse Sessions-page gate.
- `managed-agent-defaults.js`: validates sparse single-model per-account
  provider/model/thinking defaults and resolves personal, inherited, or
  host-managed execution without exposing Supabase or mutating agent files.
  Managed developers require Host Settings plus Agents Read/Edit; Council and
  host-level agent mutation remain outside this personal path.
- `session-ownership-index.js`, `session-visibility.js`, `session-folders.js`:
  private hot-path ownership enforcement, managed global-list pagination and
  strict reconciliation matching, and server-backed per-principal folder state.
- `branch-target.js`: logical branch normalization/provenance and idempotent
  assigned-branch worktree resolution shared by chat and scheduled execution.
- `runtime.js` also exposes authoritative scheduled-task access classification
  and notifies the scheduler after owner/project/branch access mutations.
- `dotenv-visibility.js`: non-admin managed-role dotenv concealment for file
  discovery, reads, Git changes/diffs, and OpenCode file/search responses.
- `branch-authorization.js`: request-scoped project resolution and exact logical
  branch-write authorization shared by Git integration and GitHub PR actions.
- `request-context.js`: AsyncLocalStorage context consumed by Git and GitHub.
- `bug-reports.js`: managed report submission/review APIs, cursor pagination,
  optimistic status updates, administrator-only sanitized error-log reads with
  actionable-by-default disposition filtering, unfiltered UUID details, and
  snapshot clearing through the service-role diagnostic RPC.
- `audit-outbox.js`, `activity-projection.js`: durable idempotent actor audit,
  deferred telemetry delivery, an exclusive flush barrier for diagnostic
  clearing and Bot audit pruning, content-free OpenCode tool/file projection, and active-worktree-aware
  failure projection for sessions, tools, and managed tasks. Context-mode disk
  I/O failures are rewritten to a stable wedged-handle message.
- `error-diagnostics.js`, `diagnostic-recovery.js`: shared immutable
  impact/failure-class/disposition policy, expected-outcome classification, and
  append-only recovery/unresolved correlation.
- `analytics.js`: human-prompt extraction and truncation, strict interaction
  validation, privacy-safe field deltas, opaque event cursors, reviewer
  redaction, and DST-aware daily activity aggregation.
- `analytics-retention.js`: monotonic managed-developer retention locks,
  protected audit purge dispatch, and migration-contract errors.

## Flow

1. `runtime.js` loads private Supabase configuration and the encrypted vault.
2. Login exchanges credentials with Supabase Auth, or explicitly selects one
   loopback-only agent-test role, and issues an opaque app cookie.
3. Each API/WS request resolves a live profile, effective policy, and assignments.
   Managed principals with Bots disabled are rejected before any Bot capability,
   catalog, event, channel, action, or run route executes.
4. Non-admin request paths are confined to a granted repository root or that
   repository's shared OpenCode worktree container before feature routes run.
5. Responses/events are ownership-filtered and host paths are publicized.
   Newly created root sessions remain provisional and invisible until durable
   ownership commits, then publish one authoritative lifecycle event. The
   global experimental session list fills managed pages across hidden upstream
   rows without exposing another user's session metadata.
6. Admin mutations and direct user actions are appended to the durable actor
   audit. Human prompts, explicit file opens, bounded sanitized copied text,
   and impact-classified runtime failures use the same outbox; recovery is
   linked by separate deterministic activity events and OpenCode projections
   never contribute to user analytics.
7. Error Log clearing flushes the outbox under an exclusive delivery barrier,
   captures a cutoff, and atomically deletes only matching failures and their
   linked resolution evidence; newly queued events deliver after the barrier.
8. Exact owned session deletion strips legacy directory scope, locks non-admin
   analytics retention, deletes upstream content, and tombstones ownership.
9. Missing session ownership is repaired only when a canonical directory maps
   to one active user; archived tombstones and ambiguous matches remain hidden.
10. Revocation closes live connections and archives affected ownership records;
   shared real worktrees are never moved or removed by visibility-grant changes.
11. Explicit managed settings saves serialize per principal. Fresh drafts and
   owned child dispatches overlay sparse personal agent defaults on the live
   host catalog; resets restore live inheritance. Council always uses its
   host-managed multi-model roster.
12. Production Bots persistence stays behind service-role-only forced-RLS
    relations and security-invoker RPCs. Missing relation, column, or RPC
    contracts map to the pinned Bot migration `503` envelope before Bot work is
    admitted. The compatibility gate includes durable profile/avatar columns,
    write-only Bot environment-secret metadata, generated-image source keys,
    and the exact-version publish RPC. Immutable Skill/MCP binding rows,
    encrypted profile avatars, and separately confirmed host-vault secret
    records are included in recovery and
    ordered purge. Retired-Bot purge preserves audit rows and crosses the outbox
    delivery barrier before applying one-year retention.

## Integration

- Composed by `packages/web/server/index.js` ahead of generic OpenCode proxying.
- Supplies request context to `lib/git/` and `lib/github/`, and owner checks to
  `lib/event-stream/`, `lib/terminal/`, notifications, preview, TTS, and push.
- Admin/senior views are rendered by
  `packages/ui/src/components/sections/users/UserManagementPage.tsx`.
- Managed issue intake and exact-admin failure review are rendered by
  `packages/ui/src/components/sections/bug-reports/BugReportsPage.tsx`.
