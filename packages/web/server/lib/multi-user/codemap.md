# packages/web/server/lib/multi-user/

## Responsibility

Server-only multi-user identity, policy, project/branch assignment, session
ownership, directory opacity, and audit control plane.

## Main files

- `runtime.js`: composition root, auth/session lifecycle, HTTP/SSE/WS policy,
  administration routes (including the token-free GitHub account inventory and
  atomic owner reassignment), exclusive profile/account assignments, ownership,
  and live revocation.
- `auth-compat.js`: canonical-to-legacy user-policy read compatibility,
  structured identity/schema errors, and loopback agent-test fixture selection.
- `user-profile-visibility.js`: authoritative account-kind constants and the
  human-only profile query used by User Management.
- `config.js`, `supabase-client.js`, `vault.js`: private configuration,
  server-only Supabase transport, and encrypted token persistence.
- `policy.js`: exact role templates, canonical settings Read/Edit permissions,
  sparse per-user overrides, route/field ownership, and capability evaluation.
- `session-ownership-index.js`, `session-visibility.js`, `session-folders.js`:
  private hot-path ownership enforcement, managed global-list pagination and
  strict reconciliation matching, and server-backed per-principal folder state.
- `branch-target.js`: logical branch normalization/provenance and idempotent
  assigned-branch worktree resolution shared by chat and scheduled execution.
- `request-context.js`: AsyncLocalStorage context consumed by Git and GitHub.
- `audit-outbox.js`, `activity-projection.js`: durable idempotent actor audit,
  deferred telemetry delivery, and content-free OpenCode tool/file projection.
- `analytics.js`: human-prompt extraction and truncation, strict interaction
  validation, privacy-safe field deltas, opaque event cursors, reviewer
  redaction, and DST-aware daily activity aggregation.

## Flow

1. `runtime.js` loads private Supabase configuration and the encrypted vault.
2. Login exchanges credentials with Supabase Auth, or explicitly selects one
   loopback-only agent-test role, and issues an opaque app cookie.
3. Each API/WS request resolves a live profile, effective policy, and assignments.
4. Non-admin request paths are confined to a granted repository root or that
   repository's shared OpenCode worktree container before feature routes run.
5. Responses/events are ownership-filtered and host paths are publicized. The
   global experimental session list fills managed pages across hidden upstream
   rows without exposing another user's session metadata.
6. Admin mutations and direct user actions are appended to the durable actor
   audit. Human prompts, explicit file opens, and copy metadata use the same
   outbox; OpenCode tool/file projections never contribute to user analytics.
7. Missing session ownership is repaired only when a canonical directory maps
   to one active user; archived tombstones and ambiguous matches remain hidden.
8. Revocation closes live connections and archives affected ownership records;
   shared real worktrees are never moved or removed by visibility-grant changes.

## Integration

- Composed by `packages/web/server/index.js` ahead of generic OpenCode proxying.
- Supplies request context to `lib/git/` and `lib/github/`, and owner checks to
  `lib/event-stream/`, `lib/terminal/`, notifications, preview, TTS, and push.
- Admin/senior views are rendered by
  `packages/ui/src/components/sections/users/UserManagementPage.tsx`.
