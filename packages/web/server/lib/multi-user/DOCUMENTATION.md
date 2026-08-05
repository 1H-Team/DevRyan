# Multi-user control plane

## Purpose

This module provides the server-only Supabase identity and authorization layer
for shared DevRyan hosts. It owns opaque application sessions, role and user
policy evaluation, managed project/branch visibility assignments, path containment,
session ownership, admin APIs, encrypted Supabase token storage, and actor audit
records. Administrator-only per-user analytics are projections over those same
audit rows; there is no parallel analytics database.

When the three Supabase values are absent, the runtime wraps the existing UI
password controller with a single `local-admin` principal. This preserves local
behavior without weakening managed-host checks.

## Assigned branch targets

- Local refs (`dev`, `refs/heads/dev`) and same-name remote refs are one logical grant.
- `GET /api/admin/projects/:projectId/branches` retains `branches: string[]` and adds provenance-aware `branchOptions` records.
- `POST /api/projects/:projectId/branch-target` accepts a granted logical branch and idempotency key. It reuses a linked worktree, uses the primary checkout only when it is already on that exact branch, or creates a durable worktree from the local/preferred remote ref. It never falls back to another branch.
- Worktree creation requests from managed non-admin users are validated against their granted base branches in core request policy.

## Runtime metadata and personal schedules

- Exact read-only `GET /api/config/agents` is a chat-bootstrap dependency. Users without Agents-page read access receive only name/model/variant/modelRefs/councillor selections; prompts, paths, permissions, sources, and stale override internals are omitted. Agent mutations remain Agents-edit gated.
- Scheduled task routes bypass only the generic Projects-settings gate and enforce project assignment plus task ownership themselves. Managed non-admin users see and mutate only their own tasks; administrators can manage all tasks, including legacy ownerless records.
- Scheduled execution reloads the owner and branch grant, prepares the branch target, and persists session ownership before submitting a prompt.

## Configuration

Set `OPENCHAMBER_SUPABASE_URL`,
`OPENCHAMBER_SUPABASE_PUBLISHABLE_KEY`, and
`OPENCHAMBER_SUPABASE_SECRET_KEY`. The equivalent `SUPABASE_*` names are also
accepted. A mode-`0600` `<data-dir>/supabase.json` file may be used instead.

The secret key is sent only in Supabase's `apikey` header when it is a modern
`sb_secret_...` value. Legacy service-role JWT keys also use Bearer auth.

## Security boundaries

- Browser clients receive opaque DevRyan session cookies, never Supabase tokens.
- Managed account passwords require at least four characters and have no
  letter, number, case, or symbol composition requirement.
- Refresh/access tokens are AES-256-GCM encrypted in the host vault.
- Every managed `/api` request resolves one principal and runs in an
  AsyncLocalStorage request context.
- Mutations require `X-DevRyan-CSRF: 1`.
- Every role receives real repository paths. Non-admin paths must be contained
  by a granted project's repository root or its shared OpenCode worktree
  container; administrators retain canonicalized host-wide pass-through.
  Existing symlinks are resolved before containment checks, so a
  non-administrator cannot escape either allowed root through a symlink.
- Scoped OpenCode mutations may send `X-OpenCode-Directory` as either a raw
  path or the SDK's percent-encoded form. Authorization preserves a valid raw
  path first, otherwise decodes exactly once, then applies the same canonical
  assignment and symlink-containment checks before forwarding the canonical
  header upstream.
- Foreign sessions return 404 and list/status/event results are filtered.
- `GET /api/experimental/session` is a managed endpoint rather than a generic
  proxy. It preserves the OpenCode query contract, advances upstream cursors
  across hidden rows until the caller-visible limit is filled, and exposes only
  a cursor derived from the last visible session.
- Developer file and terminal access is denied in core middleware.
- Settings-page reads and mutations are authorized independently through the
  canonical Read/Edit matrix. Administrator access remains fixed at full; an
  administrator may explicitly delegate a host-global settings page to another
  role or user without granting unrelated terminal, file, Git, or GitHub access.
- Managed Git mutations operate on the real checked-out branch. Branch grants
  are a client visibility filter only and do not authorize core Git access.
- Revoking an app session, project, or branch aborts owned prompts, closes live
  transports and terminals, and archives ownership. It never moves, removes, or
  archives a shared real worktree.
- A remembered loopback administrator may use a validated snapshot for at most
  24 hours during a Supabase outage; remote access fails closed and host/account
  management returns `503` during that grace window.
- Missing, expired, revoked, or inactive sessions are removed from the local
  vault and principal cache, their cookie is expired, and session status returns
  `401`. Transient Supabase failures preserve local session state and return
  `503 identity_unavailable`; the remembered-administrator grace path still
  takes precedence when it is eligible.
- Existing UI-password-bound passkeys may be exchanged only on loopback for the
  initial active administrator's opaque app session. Remote registration and
  passkey login remain disabled; no passkey can select another user.
- Assigned developers may list, inspect, validate, preview, create, retry, and
  remove real worktrees, plus create and check out branches. Identity,
  credential, and template administration remains administrator-only.
- Detailed prompt, file-open, and copy analytics are administrator-only.
  Senior developers keep their existing non-sensitive activity view, with
  detailed analytics actions removed and remaining metadata stripped.
- A managed principal may read the public identity for their profile-assigned
  GitHub account even when GitHub operations are disabled. This exact status
  read does not exercise the token; repository and account-management routes
  remain capability- and role-gated.

## Main files

- `runtime.js`: principal/session lifecycle, authorization, admin/settings/session routes.
- `auth-compat.js`: mixed-schema policy reads, structured auth dependency errors,
  and strict agent-test identity discovery/selection.
- `supabase-client.js`: Auth Admin, password/refresh, and PostgREST transport.
- `vault.js`: encrypted atomic token vault.
- `audit-outbox.js`: sanitized atomic audit queue with idempotent Supabase delivery.
- `policy.js`: role defaults, per-page Read/Edit evaluation, capability merging,
  settings field ownership, and settings-route ownership.
- `request-context.js`: authoritative request principal context for Git/GitHub.
- `session-ownership-index.js`: private hot-path ownership mirror rebuilt from Supabase.
- `session-visibility.js`: ownership-filtered global pagination and strict
  canonical assignment matching for reconciliation.
- `session-folders.js`: bounded validation for per-principal server-backed folder state.
- `activity-projection.js`: content-free OpenCode tool/file event projection.
- `analytics.js`: prompt extraction, interaction validation, safe settings
  deltas, cursor helpers, reviewer redaction, and daily activity aggregation.

## Principal-owned state

- `GET/POST /api/session-folders` stores validated folder metadata on the
  principal's `user_policies` row; browser-local folder state is not shared.
- Managed settings responses merge role defaults, sparse per-user permission
  overrides, and user-scoped setting values. Read determines which page-owned
  values are returned; Edit determines which changes and page-owned mutations
  are accepted. `settings_pages` remains a legacy Read projection while
  `settings_permissions` and `settings_permission_overrides` are authoritative.
- Settings Home is always readable. `behavior` resolves to the `agents` policy;
  Skills Catalog is independently controlled. Edit always requires Read.
- The read-only `/api/config/providers` model catalog is a chat bootstrap
  dependency and remains available when the Providers settings page is hidden.
  Provider credentials, authentication routes, and catalog mutations remain
  protected by the Providers Read/Edit permission.
- Project settings contain one stable server-owned project ID per repository.
  Assigned branches are nested beneath that project in deterministic order;
  clients may synthesize branch rows but must not replace the project UUID or
  maintain a second browser-owned metadata overlay. Project label, icon, and
  color metadata live on `managed_projects`, are mutable only through the admin
  project endpoint, and are projected back through managed settings.
- Every branch visibility row stores the registered repository path. Runtime
  principals ignore legacy per-user workspace paths and derive the same shared
  OpenCode worktree container used by `/api/git/worktrees`.
- Resetting a user policy clears only policy and setting overrides. It preserves
  the same row's session-folder state.
- After OpenCode becomes reachable, one single-flight reconciliation enumerates
  active and archived sessions. An unowned session is claimed only when its
  canonical directory matches assignments belonging to exactly one active
  user; multiple branches for that user resolve deterministically. Existing
  archived ownership tombstones are never revived, and ambiguous or unmatched
  sessions remain unclaimed and hidden. Archive, unarchive, and delete retry
  this reconciliation when ownership is missing before returning the normal
  foreign-session `404`.
- Administrators and developers have identical lifecycle ownership rules: each
  can archive, unarchive, or hard-delete only their own sessions. Archive uses
  OpenCode's reversible timestamp. Hard delete removes OpenCode content and
  tombstones ownership, but does not clear the diagnostic journal or actor
  audit; those records remain until their normal retention window or an
  explicit diagnostics/audit purge.
- `user_profiles.github_account_id` is the authoritative, nullable GitHub
  association for a user, with a partial unique index making each stored
  account exclusive to one profile. Assignments mirror it only for
  compatibility. User
  creation, invite acceptance, Git operations,
  and GitHub clients all derive the same profile value. Profile-only GitHub
  changes clear principal caches and reconnect the target without revoking the
  app session; actual role or status changes keep full session revocation.
- The administrator account inventory never returns tokens. Disconnect is
  targeted by account id and fails with `GITHUB_ACCOUNT_ASSIGNED` until the
  profile owner is explicitly unassigned. `PUT
  /api/admin/github-accounts/:accountId/assignment` atomically moves an account
  to a visible human profile, the signed-in administrator, or no owner without
  deleting the stored credential. Other agent-test fixtures remain invalid
  targets. Assignment conflicts return deterministic conflict codes from both
  preflight and database races.

## Real-worktree migration rollout

Apply `20260804100000_user_profile_github_account.sql`,
`20260804110000_real_worktree_visibility_grants.sql`, and
`20260804120000_github_account_reassignment.sql` before deploying the runtime
change. The last migration installs the service-role-only atomic reassignment
function. The real-worktree migration keeps `workspace_path` for rollback
compatibility but repairs every grant to the registered repository path.

After the deployment is stable, operators may remove the retired per-user
worktree directory if it is empty and delete leftover internal branches after
reviewing them:

```bash
git branch --list 'devryan/*'
```

The legacy directory is `<data-dir>/worktrees/` (normally
`~/.config/openchamber/worktrees/`). Cleanup is deliberately manual; runtime
grant changes never delete shared or legacy worktrees.

## AI-agent test identities

- `user_profiles.account_kind` is the authoritative distinction between normal
  `human` profiles and `agent_test` fixtures. New users created through DevRyan
  are always human profiles.
- `Test Administrator` and `Test Developer` are reserved exclusively for AI
  agents exercising administrator and developer feature paths. They still pass
  through the normal authentication, policy, assignment, ownership, and audit
  enforcement used by every managed account.
- Agent-test profiles are deliberately excluded by the server from
  `GET /api/admin/users`. They therefore do not appear in the Users list or its
  policy and assignment selectors, and must not be used as human accounts.
- `POST /auth/agent-test-session` is a loopback-only, password-free login for
  active `agent_test` profiles. It accepts the canonical `{ role: "developer" |
  "admin" }` request and retains the legacy `{ email }` request for scripts. A
  role or email must resolve to exactly one active fixture; conflicting role and
  email requests, duplicates, human profiles, and remote callers are rejected.
  The server mints a Supabase magic link and verifies it internally, then issues
  a normal opaque app session (audited as `auth.agent_test_login`). No
  credentials ever pass through the agent. See AGENTS.md
  ("Multi-user visual verification") for the agent-facing recipe.
- Unauthenticated loopback `GET /auth/session` responses advertise only the
  available role/label pairs. Email addresses are never returned and remote
  callers never receive `agentTestIdentities`.

## Authentication failure and reset contract

- `GET /auth/session` returns `503` with `code: "identity_unavailable"` for a
  genuine identity dependency outage, or `code: "schema_migration_required"`
  plus `requiredMigration` for an incompatible database schema. Loopback
  responses with a local cookie may also set `localResetAvailable: true`.
- Policy reads first request `settings_permission_overrides`. Only the exact
  PostgREST missing-column error retries the legacy projection, and one
  sanitized warning is emitted per runtime. Unrelated errors propagate.
  Permission-matrix writes never downgrade: they return
  `503 schema_migration_required` until migration `20260803150000` exists.
- `GET /api/admin/github-accounts` returns the same structured `503` contract
  with required migration `20260804100000` when the profile association column
  is missing, without blanking the other User Management datasets.
- `PUT /api/admin/github-accounts/:accountId/assignment` returns the structured
  migration-required contract with `20260804120000` when the atomic transfer
  function is unavailable.
- `POST /auth/logout` and `DELETE /auth/session` always expire the cookie, evict
  the principal cache, delete the matching vault record, and close owned live
  connections before reporting remote status. Remote revocation is best effort;
  a dependency failure returns `localSessionCleared: true` and
  `remoteRevoked: false` so clients can complete local logout safely.
- A valid `/tunnel/connect` exchange calls `prepareFreshTunnelLogin` before the
  one-time token is consumed. It requires confirmed `app_sessions` revocation,
  removes the matching encrypted vault entry, expires only the browser's app
  cookie, and closes only connections belonging to that app session. It does
  not abort the user's owned OpenCode sessions or terminate terminal processes.
  Any remote or vault cleanup failure rejects the exchange with retryable `503`;
  invalid links never call this path and the bootstrap token remains usable for
  a later retry.

## Audit contract

The outbox is appended before auditable mutations and flushed idempotently to
`activity_logs` with an explicit `event_id` conflict target. Validated UUIDs,
OpenCode correlation IDs, and the UUID linking a completed mutation to its
requested event survive sanitization; free-form high-entropy metadata remains
redacted. Records may contain bounded prompt text supplied by the actor,
tool name/state, logical branch, project-relative paths, Git SHA/PR metadata,
and outcomes. They never contain passwords, tokens, raw host paths, agent-read
file contents, assistant/tool output, or terminal I/O. Terminal audit is limited
to open and close lifecycle events. Session lifecycle outcomes are recorded as
`session.archived`, `session.unarchived`, and `session.deleted`; delete metadata
distinguishes upstream removal from ownership tombstoning so partial failure is
visible without storing session content.

## User analytics contract

- Browser-origin human sends mark `POST /api/session/:sessionID/prompt_async`
  with `X-DevRyan-Prompt-Origin: human`. A successful 2xx acceptance persists
  `prompt.sent` locally before the response ends, keyed idempotently by the
  client message ID. Scheduled work, subagent traffic, internal continuations,
  assistant/tool output, and synthetic text parts are excluded.
- Prompt metadata contains receipt time, project/branch/session correlation,
  agent, provider/model, variant, attachment count, and concatenated
  non-synthetic text capped at 16 KiB with original length and truncation state.
  The mandatory outbox sanitizer still applies. Attachment and file contents
  are never recorded.
- `POST /api/analytics/events` accepts at most 50 authenticated, CSRF-protected
  `file.opened` or `clipboard.copied` records. Identity comes only from the app
  session. File paths must be project-relative and contained by an assignment;
  copy rows accept surface, kind, character count, and optional relative path,
  never clipboard content. Per-item results make partial failure retryable.
- Analytics telemetry uses `audit-outbox.enqueueDeferred`: acknowledgement
  waits for the sanitized local record, not Supabase delivery. The supplied
  occurrence time becomes `activity_logs.created_at`, so an outage does not
  move events into the later delivery hour. `event_id` conflict handling makes
  browser and prompt retries idempotent.
- `GET /api/admin/users/:userId/analytics/daily` returns selected-day totals,
  real 23/24/25-hour local buckets, and event-derived activity blocks. A gap
  greater than 30 minutes starts a new block; each block ends five minutes
  after its final direct event and is clipped to the local day.
- `GET /api/admin/users/:userId/analytics/events` provides bounded prompt,
  interaction, or safe-change pages with opaque newest-first cursors and
  date/time-zone/agent/model/search filters. Both analytics GET routes require
  an administrator and a visible human target profile.
- Settings/profile/policy/project/access audits carry allowlisted field deltas.
  Booleans, numbers, roles, names, branches, defaults, and permission or
  capability states may include before/after values. Secrets, tokens, paths,
  URLs, prompt/template fields, and arbitrary JSON expose only changed keys or
  collection counts. Invitation rows carry their target user correlation.
- Retention and purge remain the existing `activity_logs` policy. Export reads
  every retained page instead of truncating at 10,000 rows; non-admin exports
  apply the same detailed-action removal and metadata stripping as the list.
