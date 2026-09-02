# Multi-user control plane

## Purpose

This module provides the server-only Supabase identity and authorization layer
for shared DevRyan hosts. It owns opaque application sessions, role and user
policy evaluation, managed project/branch visibility assignments, path containment,
session ownership, admin APIs, encrypted Supabase token storage, and actor audit
records. Administrator-only per-user analytics are projections over those same
audit rows. Administrator Error Logs also read the same sanitized audit rows;
there is no parallel analytics or logging database. Manual Bug Reports use one
separate service-only table because they have a durable status workflow.

When the three Supabase values are absent, the runtime wraps the existing UI
password controller with a single `local-admin` principal. This preserves local
behavior without weakening managed-host checks. That compatibility principal is
never eligible for Managed Remote, which requires separately attributable managed
accounts before connector startup or public-host API access.

## Production Bots persistence

Migrations `20260822120000_production_bots.sql`,
`20260823100000_bot_recovery_purge.sql`, and
`20260823150227_bot_capability_bindings.sql`, followed by
`20260823202400_bot_profiles_and_publish.sql` through
`20260826130000_bot_two_phase_responses.sql` and
`20260826140000_bot_environment_secrets.sql`, own the server-only Production
Bots control plane. Their tables cover durable Bot profiles, encrypted profile
avatars, immutable revisions,
memberships and continuous-channel ACLs, messages and objects, queued runs and
action approvals, credential and environment-secret metadata, routines, memory and Library versions,
immutable Skill packages and MCP bindings, append-only audit history, and Test
Lab cases/runs. All Bot relations force RLS,
have no browser policies, and grant data access only to `service_role`; bulk
object bytes remain in the private `devryan-bot-objects` Storage bucket and
credential and environment-secret values remain in separate host-local vaults.

State-changing concurrency contracts live in service-role-only, security-invoker
RPCs: joined send context and channel audience reads, message sequence allocation,
FIFO run claiming by computer scope, atomic safe same-run retry, idempotent routine
occurrence claiming, extraction claim/deferral, idempotent terminal-run settlement,
revision activation, bounded audit pruning, and Draft/Retired
granular purge and server-retired one-shot full deletion.
Activated revisions and all history/version/audit records are immutable. The Bot
server layer must pass Supabase errors through
`productionBotsMigrationFailurePayload()` before continuing: a missing Bot
relation, column, or RPC fails closed as HTTP `503` with
`code: "bot_schema_migration_required"` and
`requiredMigration: "20260903110000"`. Runtime startup additionally verifies
the service-role-only `devryan_bot_schema_version()` marker, and one route
boundary blocks every Bot read or mutation while that marker is stale.

`runtime.js` is only the composition owner for this feature: after creating the
server-only Supabase transport and actor audit, it injects them into
`../bots/runtime.js`, delegates `/api/bots/*` route registration, and drains the
Bots runtime during authentication-runtime disposal. Bot repositories,
authorization, encryption, object handling, capabilities, and retention remain
in the focused `lib/bots/` module.

Native Telegram jobs have no browser session. The injected Bot principal
resolver freshly reads active profile, role policy and individual policy,
rejects disabled effective `bots` access, and avoids unrelated project/worktree
lookups. Existing Bot membership and exact channel authorization still run at
admission and delivery. Optional Telegram schema readiness does not raise the
global Bot schema marker or disable existing Bot chat.

## Assigned branch targets

- Local refs (`dev`, `refs/heads/dev`) and same-name remote refs are one logical grant.
- `GET /api/admin/projects/:projectId/branches` retains `branches: string[]` and adds provenance-aware `branchOptions` records.
- `POST /api/projects/:projectId/branch-target` accepts a granted logical branch and idempotency key. It reuses a linked worktree only after reconciling its durable bootstrap receipt, automatically retries a failed existing-branch `populate_worktree` stage, uses the primary checkout only when it is already on that exact branch, or creates a durable worktree from the local/preferred remote ref. It never falls back to another branch.
- Worktree creation requests from managed non-admin users are validated against their granted base branches in core request policy.

## Branch preview access

- `user_branch_previews` stores one normalized HTTPS preview URL and optional
  opaque service-token vault reference per user/project/logical branch grant.
  The Cloudflare Client ID and Client Secret live only in the dedicated
  AES-256-GCM host vault and never enter Supabase, API reads, audit deltas,
  diagnostics, or renderer metadata.
- Administrator-only branch-specific preview routes create/rotate, test, and
  remove the configuration independently from branch-visibility saves. Create
  and rotate validate the effective URL and service token before either the
  metadata row or encrypted vault entry changes; an Access login redirect or
  rejected token returns `branch_preview_auth_failed` and preserves the prior
  configuration. The separate test route validates unsaved drafts.
  Removing a branch or project cascades the metadata row and purges its vault
  entry after the grant mutation succeeds.
- First Browser use resolves the root session's authoritative owner and current
  project/branch. A single bounded HEAD probe (GET range fallback only when
  necessary) validates the stored Access token; no task-start connection,
  reverse proxy, background polling, or page-traffic relay is created.
- Lease metadata exposes only owner/project/branch identity, preview URL, origin,
  and configured status. The credential is passed separately through the
  private server-to-Electron callback and never retained in the lease record.

## Runtime metadata and personal schedules

- Exact read-only `GET /api/config/agents` is a chat-bootstrap dependency. Users without Agents-page read access receive only name/model/variant/modelRefs/councillor selections; prompts, paths, permissions, sources, and stale override internals are omitted. Agent mutations remain Agents-edit gated.
- Scheduled task routes bypass only the generic Projects-settings gate and enforce project assignment plus task ownership themselves. Managed non-admin users see and mutate only their own tasks; administrators can manage all tasks, including legacy ownerless records.
- Scheduler startup enumerates active managed project IDs so persisted owner-scoped timers are restored independently of the host's local-settings project list.
- Scheduled execution reloads the owner and branch grant, prepares the branch target, and persists session ownership before submitting a prompt. The live assignment directory is authoritative; a cached local project path is neither required nor accepted as managed-task authorization.
- Scheduled-task access checks distinguish active grants, reversible owner
  suspension, definitive owner/project/branch revocation, and control-plane
  verification failure. Successful revocation mutations notify the scheduler
  immediately; startup and quit-status reconciliation repair missed cleanup.

## Configuration

Set `OPENCHAMBER_SUPABASE_URL`,
`OPENCHAMBER_SUPABASE_PUBLISHABLE_KEY`, and
`OPENCHAMBER_SUPABASE_SECRET_KEY`. The equivalent `SUPABASE_*` names are also
accepted. A mode-`0600` `<data-dir>/supabase.json` file may be used instead.

The secret key is sent only in Supabase's `apikey` header when it is a modern
`sb_secret_...` value. Legacy service-role JWT keys also use Bearer auth.

## Security boundaries

- Browser clients receive opaque DevRyan session cookies, never Supabase tokens.
- Managed account passwords require at least six characters and have no
  letter, number, case, or symbol composition requirement.
- Refresh/access tokens are AES-256-GCM encrypted in the host vault.
- Every managed browser-origin `/api` request resolves one principal and runs
  in an AsyncLocalStorage request context. Electron's private browser discovery
  and lease routes are the narrow exception: they register before UI auth and
  independently require the real socket peer to be loopback plus the managed
  OpenCode bearer; missing Electron callbacks still return `404`.
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
  DevRyan managed-task updates and removals resolve their identity from the
  root session and are delivered only when that session belongs to the caller.
- Managed chat visibility is keyed only by the durable ownership row's `user_id`.
  Browser sessions, tunnel connections, local UI caches, and opaque app-session
  IDs never become chat owners, so signing in again or restarting DevRyan restores
  the same host-local OpenCode transcript for the same account.
- `GET /api/experimental/session` is a managed endpoint rather than a generic
  proxy. It preserves the OpenCode query contract, advances upstream cursors
  across hidden rows until the caller-visible limit is filled, and exposes only
  a cursor derived from the last visible session.
- Developer file and terminal access is denied in core middleware. The scoped
  owned-session plan-revision API is a separate artifact contract and does not
  grant access to `/api/fs/*`. For managed callers, it resolves storage from the
  active ownership row's current project/branch assignment and always keys the
  revision to the registered repository root, even when the session runs in a
  worktree. A request directory may confirm the assigned project but never
  selects the plan path.
- Managed developers and senior developers never receive `.env` or `.env.*`
  entries from filesystem, OpenCode file/search, Git status, conflict, or commit
  file-list responses. Direct filesystem and Git access to those paths returns
  `404` so the API does not confirm that a secret file exists. Administrators
  and the single-user local runtime retain their existing behavior.
- Settings-page reads and mutations are authorized independently through the
  canonical Read/Edit matrix. Administrator access remains fixed at full; an
  administrator may explicitly delegate a host-global settings page to another
  role or user without granting unrelated terminal, file, Git, or GitHub access.
- Bots access is a default-on canonical capability with sparse per-user
  overrides. When disabled, core middleware rejects `/api/bots`,
  `/api/bot-actions`, `/api/bot-channels`, and `/api/bot-runs` with the stable
  `bots_access_disabled` code before the Production Bots control plane runs.
  Memberships and Bot data remain intact so restoring access is non-destructive.
- Managed Git mutations operate on the real checked-out branch. General branch
  grants remain a visibility filter, while operations that directly write a
  different branch (commit reintegration, worktree creation, and PR merge
  targets) enforce the target grant in core request policy.
- Revoking an app session, project, or branch aborts owned prompts, closes live
  transports and terminals, and archives ownership. It never moves, removes, or
  archives a shared real worktree.
- A remembered loopback administrator may use a validated snapshot for at most
  24 hours during a Supabase outage; remote access fails closed and host/account
  management returns `503` with `code: "offline_grace_restricted"` and
  `retryable: true` during that grace window. The UI suppresses management
  requests, explains the degraded state, and retries authoritative session
  validation until access can be restored without reauthentication.
- The initial ownership refresh uses a five-second deadline. An initial transient Supabase outage does not prevent the local web/Electron
  runtime from listening. Startup preserves the private on-disk session
  ownership index, reports `multiUserControlPlane.state = "degraded"` from the
  health endpoint, and retries the authoritative ownership refresh with bounded
  backoff. Managed identity requests still fail closed with
  `identity_unavailable`; non-transient configuration and schema failures still
  fail startup.
- Missing, expired, revoked, or inactive sessions are removed from the local
  vault and principal cache, their cookie is expired, and session status returns
  `401`. Transient Supabase failures preserve local session state and return
  `503 identity_unavailable`; the remembered-administrator grace path still
  takes precedence when it is eligible.
- Existing UI-password-bound passkeys may be exchanged only on loopback for the
  initial active administrator's opaque app session. Remote registration and
  passkey login remain disabled; no passkey can select another user.
- Assigned developers may list, inspect, validate, and preview real worktrees,
  plus check out assigned branches. User-triggered creation and retry require
  the `createWorktrees` capability, which defaults off for developers and on
  for senior developers. Automatic assigned-branch target preparation remains
  allowed so normal session routing can create or reuse its required checkout.
  Creating a branch directly or through a new-branch worktree additionally
  requires the separate `createBranches` capability. Their worktrees are
  persistent reusable resources: worktree, local-branch, and remote-branch
  deletion routes return `403`, and session cleanup archives conversations
  without mutating Git. Managed administrators retain worktree removal as a
  maintenance capability. Identity, credential, and template administration
  remains administrator-only.
- Detailed prompt, file-open, and copy analytics are administrator-only.
  Senior developers keep their existing non-sensitive activity view, with
  detailed analytics actions removed and remaining metadata stripped.
- Delegating Bug Reports page access never delegates review. Submission needs
  that page's Edit permission, while report listing/status control and Error
  Logs require the exact managed `admin` role on every server route.
- A managed principal may read the public identity for their profile-assigned
  GitHub account even when GitHub operations are disabled. This exact status
  read does not exercise the token; repository and account-management routes
  remain capability- and role-gated.
- Browser access is a canonical role/per-user capability. It defaults on for
  developers and senior developers, is fixed on for administrators, and gates
  Browser target creation, project-instance discovery, local probing, inline
  presentation, and pop-out continuity without disabling the separate Preview
  surface.
- Source Update-tab visibility is a sparse per-user presentation override. It
  removes that tab from the right sidebar for the affected managed user without
  granting or revoking any Git capability or server-side operation.
- Browser target creation, project-instance registration, and local-instance
  probing are runtime operations rather than host-configuration mutations.
  Their route handlers enforce Browser capability, project ownership, origin,
  loopback, and CSRF checks; unknown Browser mutations remain administrator-only.
- A registered project's live terminal preview is shared by project identity,
  including when an unassigned host administrator started the terminal from
  that project's canonical repository or OpenCode worktree container. The
  grant remains terminal- and liveness-bound; it does not approve arbitrary
  host ports and does not depend on the Host Settings capability.

## Main files

- `runtime.js`: principal/session lifecycle, authorization, admin/settings/session routes.
- `managed-agent-defaults.js`: bounded single-model agent-default validation and
  personal-over-host execution resolution. Composite agents such as Council are
  deliberately host-managed.
- `auth-compat.js`: mixed-schema policy reads, structured auth and Production
  Bots migration dependency errors, and strict agent-test identity
  discovery/selection.
- `supabase-client.js`: Auth Admin, password/refresh, and PostgREST transport.
- `vault.js`: encrypted atomic application-session token vault.
- `branch-preview-vault.js`, `branch-previews.js`: dedicated encrypted preview
  credential persistence plus URL validation, redacted CRUD, connection probes,
  branch-cascade cleanup, and authoritative Browser lease resolution.
- `audit-outbox.js`: sanitized atomic audit queue with idempotent Supabase
  delivery and an exclusive flushed-delivery barrier for snapshot clearing.
- `policy.js`: role defaults, per-page Read/Edit evaluation, capability merging,
  settings field ownership, and settings-route ownership.
- `request-context.js`: authoritative request principal context for Git/GitHub.
- `session-ownership-index.js`: private hot-path ownership mirror rebuilt from Supabase.
- `session-visibility.js`: ownership-filtered global pagination and strict
  canonical assignment matching for reconciliation.
- `session-folders.js`: bounded validation for per-principal server-backed folder state.
- `bug-reports.js`: report validation/idempotency, admin cursor APIs,
  optimistic status updates, and sanitized Error Logs reads/snapshot clearing.
- `activity-projection.js`: content-free OpenCode tool/file activity plus
  bounded, deterministic session/tool/managed-task failure projection.
- `error-diagnostics.js`, `diagnostic-recovery.js`: one impact/class contract
  and bounded in-memory correlation that appends authoritative recovery or
  unresolved evidence without mutating the original failure.
- `analytics.js`: prompt extraction, interaction validation, safe settings
  deltas, cursor helpers, reviewer redaction, and daily activity aggregation.
- `analytics-retention.js`: service-role retention locking, protected activity
  purge dispatch, count normalization, and structured migration-required errors.

## Principal-owned state

- `GET/POST /api/session-folders` stores validated folder metadata on the
  principal's `user_policies` row; browser-local folder state is not shared.
- Managed settings responses merge role defaults, sparse per-user permission
  overrides, and user-scoped setting values. Read determines which page-owned
  values are returned; Edit determines which changes and page-owned mutations
  are accepted. `settings_pages` remains a legacy Read projection while
  `settings_permissions` and `settings_permission_overrides` are authoritative.
- Managed notification-template overrides inherit missing event entries from
  the effective host template set. GET and PUT responses always expose the
  total six-event contract, and any later personal settings mutation repairs a
  sparse legacy override while preserving valid customized entries.
- Host-authored Magic Prompt overrides are execution settings inherited by all
  authenticated managed users. `GET /api/magic-prompts` remains available to
  action consumers even when the Magic Prompts settings page is hidden, while
  the page itself and every PUT/DELETE mutation remain protected by the
  canonical Magic Prompts Read/Edit permission.
- `user_policies.settings_overrides` is also the service-only store for sparse
  account defaults: `defaultAgent`, `defaultPlanMode`, and
  `agentModelSelections[agentName]`. `GET /api/config/settings` reports the
  fields personally owned by the current principal in
  `multiUser.settingsOverrideKeys`; browser principals never receive direct
  Supabase table access.
- Managed developers with Host Settings and Agents Read/Edit explicitly save or
  reset one validated single-model agent default through `PUT`/`DELETE
  /api/config/settings/agent-defaults/:agentName`; `DELETE
  /api/config/settings/overrides/:field` resets `defaultAgent` or
  `defaultPlanMode`. Per-user mutations are serialized and re-read the latest
  policy row inside the lock, so concurrent saves for different agents cannot
  lose each other. These routes never mutate host agent files or request an
  OpenCode configuration apply. Audit metadata contains only the agent/field
  identity and operation, never provider, model, or thinking values.
- Managed developers are rejected from host-level agent override mutations even
  when their personal-default gate is enabled. Model and thinking selections
  affect only that principal's fresh drafts, new sessions, and owned child
  dispatches; Council remains host-managed.
- Executable defaults resolve from a personal per-agent override, then the live
  host agent configuration. Existing UI availability fallback remains the final
  display/send boundary. Durable root-session ownership selects the principal
  for managed child dispatch; missing ownership, stale assignment, or directory
  mismatch fails closed. Administrators use the live host execution, and
  Council keeps its shared ordered host roster.
- `role_policies.can_use_browser` stores the role default. Sparse
  `user_policies.capabilities.browser` values override it; an absent override
  inherits the role. Missing role columns are projected as the enabled product
  default on reads, while writes fail with the required migration identifier.
- `createWorktrees` is a policy-template capability stored only when overridden
  in `user_policies.capabilities`: developers inherit disabled, senior
  developers inherit enabled, and administrators remain fixed enabled. It
  gates user-triggered worktree creation and retries without blocking the
  server-owned assigned-branch target resolver.
- `createBranches` is a separate policy-template capability stored only when overridden
  in `user_policies.capabilities`: developers inherit disabled, senior
  developers inherit enabled, and administrators remain fixed enabled. It
  gates direct branch creation, new-branch worktrees, and retries of durable
  operations whose receipt was created in new-branch mode.
- `bots` is a policy-template capability that defaults enabled for every role
  and is stored only when overridden in `user_policies.capabilities`.
  Administrators remain fixed enabled. A disabled managed principal is denied
  before any Bot route family executes, without changing memberships or data.
- Settings Home is always readable. `behavior` resolves to the `agents` policy;
  Skills Catalog is independently controlled. Bug Reports defaults to Read/Edit
  for all managed roles and retains normal role/user override behavior. Bots is
  part of the canonical permission catalog: administrators are fixed at
  Read/Edit while senior developers and developers default to denied. Stored
  role matrices are projected onto the complete catalog, missing cells inherit
  the role default, malformed cells fail closed, and Edit always requires Read.
- `featureOverrides.agents.hideGlobalBehaviorUi` defaults enabled for
  developers and disabled for senior developers and administrators. Sparse
  policy storage preserves an explicit developer `false`, allowing Behavior to
  be exposed for one user without changing the role template. The UI does not
  mount or fetch the global behavior editor while the effective flag is true.
- `PUT /api/config/settings` is a field-owned personal-settings endpoint. Every
  changed key is validated against its canonical Settings owner; it does not
  inherit a coarse Sessions gate. In particular,
  `nativeNotificationsEnabled` requires Notifications Edit, returns a
  deterministic `403` when denied, and can be saved when Sessions Edit is off.
- The read-only `/api/config/providers` model catalog is a chat bootstrap
  dependency and remains available when the Providers settings page is hidden.
  Provider credentials, authentication routes, and catalog mutations remain
  protected by the Providers Read/Edit permission.
- Project settings contain one stable server-owned project ID per repository.
  Assigned branches are nested beneath that project in deterministic order;
  clients may synthesize branch rows but must not replace the project UUID or
  maintain a second browser-owned metadata overlay. Project label, icon, and
  color metadata live on `managed_projects`, are mutable only through the admin
  project endpoint, and are projected back through managed settings and public
  assignment snapshots. Successful metadata and icon-image mutations publish a
  project-ID-only invalidation to active administrators and users assigned to
  that project; reconnecting clients reload the authoritative assignment snapshot.
  `DELETE /api/admin/projects/:projectId` archives the project (`status=archived`),
  removes every user grant, and hides it from `GET /api/admin/projects`. Hard
  delete is avoided because session ownership cascades. Registering the same
  repository path again restores the archived row. Git-integrate temp worktrees
  (`devryan-integrate-*` under the OS temp dir) cannot be registered; admin
  sessions opened there bind ownership to the already-registered parent
  repository instead of creating a leftover managed project.
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
- Managed root-session creation is provisional until durable ownership commits.
  The provisional ID is hidden from session lists, status responses, and live
  lifecycle events while the runtime retries the same idempotent Supabase
  ownership upsert four times with a five-second per-attempt timeout. A commit
  writes the local ownership index and audit record before publishing one
  authoritative `session.created` event. Exhaustion rolls back the single
  OpenCode session and returns `503 identity_unavailable` with
  `retryable: false`; incomplete cleanup remains hidden, returns
  `session_create_outcome_unknown` with `retryable: false`, and is retried in the
  background. Only an explicit restart rejection before dispatch is retryable;
  transport failures after dispatch cannot prove that creation failed. Early
  attempt timings record upstream creation and ownership commit separately.
- Administrators and developers have identical lifecycle ownership rules: each
  can archive, unarchive, or hard-delete only their own sessions. Archive uses
  OpenCode's reversible timestamp. Exact `DELETE /api/session/:sessionID`
  requests are authorized by durable ownership plus the user's current
  project/branch grant. Any SDK-supplied directory query, body field, or header
  is removed before path translation and OpenCode forwarding, so an owned
  archived session can be deleted after its legacy directory leaves the current
  worktree grant. Deletion is idempotent only inside that same strong boundary:
  an owned tombstone with a still-current grant returns the SDK-compatible
  boolean success without another upstream call, while an active owned row
  whose upstream session is already absent completes its tombstone and returns
  success. This also makes an upstream-delete/tombstone-write partial failure
  recoverable on retry. Foreign, revoked, or unowned IDs retain the
  indistinguishable `404` response. All other session routes retain directory
  translation and scope checks.
- Before deleting OpenCode content for a developer or senior developer, the
  runtime monotonically locks that user's analytics retention. A missing
  `20260807100000` migration fails with `503 schema_migration_required` before
  upstream deletion. The lock is deliberately not rolled back on later
  upstream or ownership-tombstone failure, protecting purge races and delayed
  audit-outbox deliveries. A successful hard delete tombstones ownership as
  before. Diagnostic-journal records remain under their existing bounded
  retention; the indefinite guarantee applies to actor/target user analytics.
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

## Managed bug reports and error logs

- The canonical `bug-reports` settings permission defaults to Read/Edit for
  every managed role and remains subject to normal role and sparse user
  overrides. The page is not available to local-only or VS Code runtimes.
- `POST /api/bug-reports` accepts exactly a client UUID, title (1–200
  characters), and description (1–20,000 characters). Identity snapshots and
  the initial `submitted` status come from the authenticated server principal.
  Reusing the UUID with identical actor/content is idempotent; different
  content returns `409`.
- Exact managed administrators may list and inspect reports with bounded,
  opaque newest-first cursors. `PATCH /api/bug-reports/:id` accepts only a
  reversible workflow status and `expectedUpdatedAt`; a stale comparison
  returns `409`. Transition audits contain only report identity and from/to
  statuses, never report text.
- `bug_reports` is a service-role-only table with forced RLS and no browser
  policies. Reporter name/email/role snapshots are immutable report fields;
  status and `updated_at` are the only administrator-managed values. Missing
  schema returns `schema_migration_required` with
  `20260809190612_bug_reports`.
- Error Logs reuse `activity_logs` and the durable audit outbox. The hot event
  path classifies relevant events before ownership or database work, ignores
  streaming deltas, intentional session aborts, and exact `Tool execution
  aborted` boilerplate, and attributes failures through
  durable session ownership even when the user no longer has a current project
  assignment. Failed recoverable managed tasks are held out while a retry is
  available; a recovered retry produces no failure row, while an abandoned or
  exhausted failed/interrupted attempt produces `managed_task.failed`.
- `session.error`, `tool.failed`, and `managed_task.failed` use deterministic
  event UUIDs. Their metadata is limited to actor/project/session correlations,
  provider/model/agent identity, tool/task/message IDs, safe error
  classification, stable tool error codes, and sanitized UTF-8 failure text
  capped at 8 KiB. Tool arguments are never retained merely to capture a code. Prompts,
  commands, tool output, arbitrary headers, response bodies, credentials, and
  raw host paths are excluded before the outbox persists the row. Context-mode
  SQLITE_IOERR / disk-I/O tool failures are rewritten to a stable wedge message
  that still contains `SQLITE_IOERR`, so classification stays `medium` /
  `tool_runtime` without looking like a host disk fault. `database is locked`
  remains an actionable ordinary runtime error but does not trigger process
  recovery.
  Model attempts to call an unavailable tool are classified as low-impact
  `input` failures because the rejected invocation never enters tool execution.
  Context Mode's deterministic `ctx_execute_file` project-boundary rejection is
  also low-impact `input`; genuine Context Mode SQLite, disk-I/O, locking, and
  other runtime failures remain `medium` / `tool_runtime`. A Context Mode call
  that successfully invokes a nested command which exits nonzero is retained as
  low-impact `command_exit`, because the command failed without the tool runtime
  itself failing.
  Structured error codes take precedence over compatibility message matching.
  For `devryan_browser`, `DEVRYAN_BROWSER_EVAL_ERROR` marks explicitly identified
  caller-authored JavaScript TypeError, ReferenceError, and SyntaxError failures;
  `DEVRYAN_BROWSER_INPUT_INVALID` marks rejected browser input, including invalid
  inspection selectors. Both stay failed tool calls with sanitized details but
  classify as `low` / `input` / `expected`. When OpenCode serializes the error as
  a string, only an exact leading `DEVRYAN_BROWSER_EVAL_ERROR:` or
  `DEVRYAN_BROWSER_INPUT_INVALID:` is accepted; embedded codes and prefixes from
  other tools do not qualify, and a structured code blocks this string fallback.
  `DEVRYAN_BROWSER_LEASE_TOUCH_FAILED`, as a structured code or exact leading
  string prefix, takes priority over input-message patterns: a failed final
  lease touch remains actionable even when it includes a secondary caller-eval
  or invalid-selector failure.
  Unexpected generated-script failures and malformed/truncated inspection
  results use `DEVRYAN_BROWSER_INSPECTION_FAILED`; this browser-only structured
  code or exact leading string prefix also remains actionable ahead of
  input-message patterns. Invalid CSS selector syntax still uses
  `DEVRYAN_BROWSER_INPUT_INVALID`. Other browser lease, connection, cleanup, and
  command failures retain their existing classifications. This policy
  applies to newly observed failures; it does not rewrite historical rows or
  infer recovery from unrelated successful browser commands.
  Missing skills, invalid fields, explicit tool-policy denials, managed-task
  barriers, already-acknowledged results, patch-context misses, routine browser
  target/reference/evaluation errors, and benign client ResizeObserver notices
  are expected low-impact input noise. Browser host/lineage failures, managed
  terminal failures, render crashes, and unresolved provider/runtime failures
  remain actionable. Paired OpenCode `session.error` wrapper/stack variants are
  canonicalized by session, message, and semantic first-line failure; variants
  observed within one second reuse one deterministic event ID, while later
  attempts remain separate. Historical correction migrations preserve every
  row and event ID, temporarily suspend the immutable-classification trigger,
  update only confirmed signatures, and restore the trigger in the same
  transaction.
- New failures carry immutable `diagnostic_impact` (`low`, `medium`, `high`, or
  trusted-core-only `critical`), `diagnostic_source=observed`, and
  `diagnostic_disposition` (`actionable` or `expected`). Legacy error rows are
  backfilled by narrow failure patterns with `diagnostic_source=inferred`;
  filesystem probes, patch misses, malformed search regexes, command exits,
  policy/workspace denials, browser/web target misses (including refused local
  preview ports), exact targeted ripgrep execution failures with a sanitized
  path, and record-size limits are expected and low impact. Missing or non-string
  bundled `read.path` input is rejected before execution with
  `DEVRYAN_TOOL_INPUT_INVALID` and is also expected input misuse. Session
  errors without explicit retryability reuse the shared provider transport
  classifier and expose its existing allowlisted `failureKind`; explicit
  retryability remains authoritative. Recognized provider transport failures on
  child sessions are expected and low impact while retryability is not explicitly
  false; root-session failures and exhausted `managed_task.failed` events remain
  actionable. `Upstream idle timeout exceeded` is normalized to
  `stream_idle_timeout`.
  Context IOERR, generic MCP/runtime failures, non-recoverable session failures, genuine managed
  task failures, client crashes, and platform integrity/security failures stay
  actionable. A completed managed task given `retry` is expected input misuse;
  the safety gate requires `continue` and returns `DEVRYAN_TOOL_INPUT_INVALID`.
  Failure class stays in sanitized metadata. A later successful tool followed
  by authoritative session idle appends `diagnostic.recovered`; terminal
  session/task evidence appends `diagnostic.unresolved`, linked through the
  original event UUID. Idle without successful continuation, process restart,
  or missing retained evidence remains `unknown`; high/critical events cannot
  be downgraded.
- `session.created` / `session.updated` supplies the authoritative active
  directory for projection. Runtime assignment and repository/worktree
  containment checks must accept it before it is registered as a sanitizer
  worktree root. This produces `<WORKTREE_…>/relative/path` failure text and
  active-worktree-relative `paths` without redirecting or rewriting tool input.
- `GET /api/error-logs`, `GET /api/error-logs/:eventId`, and
  `DELETE /api/error-logs?range=24h|7d|14d|all` are exact-admin routes over
  session, tool, managed-task, and client error actions. Lists default to
  `disposition=actionable` and accept `expected` or `all`, compose that filter
  with kind/impact/date/actor/search filters, and retain opaque stable cursors.
  Direct UUID detail lookup is intentionally unfiltered. Clearing first audits
  the request, exclusively flushes the durable outbox, captures a request
  cutoff, and calls the service-role-only `devryan_clear_error_logs` RPC. The
  transaction removes matching user-visible failures plus linked
  `diagnostic.recovered`/`diagnostic.unresolved` evidence, including rows owned
  by retention-locked developers, while later events and every unrelated audit
  action remain protected. The response reports `clearedCount` for visible
  failures and `linkedResolutionCount` for evidence rows. An undeliverable
  backlog or failed RPC releases the delivery barrier without deleting data;
  an absent RPC returns `schema_migration_required` with
  `20260810182541_clear_managed_error_diagnostics`. List and detail responses
  expose disposition, impact, classification source, failure class, and recovery outcome.
  A missing disposition column reports
  `20260815141850_add_diagnostic_disposition` without hiding direct evidence.
  Detail exposes only an allowlist
  suitable for agent context; task-scoped diagnostic export continues to use
  the existing diagnostics API when a session ID is present.

An Error Log event UUID is an administrative locator, not a journal record ID.
Resolve it through `GET /api/error-logs/:eventId` and capture the returned
`sessionId`, timestamp, action/kind, and available `callId`, `toolId`,
`messageId`, or `taskId`. Then inspect the corresponding host journal with the
session plus the strongest identifier, normally
`bun scripts/journal.mjs show <sessionID> --grep <callId>`; fall back to another
identifier or a bounded timestamp window and always run
`bun scripts/journal.mjs gaps` before concluding. The Error Log UUID is not
expected to occur in journal records. Error Logs remain the durable sanitized
administrative index and classification store; the local journal remains the
execution-evidence source for prompts, tool output, lifecycle ordering,
recovery, and detailed failures. If that host journal is unavailable, expired,
or has a qualifying gap, the missing evidence must be reported rather than
reconstructed.

## Real-worktree migration rollout

Apply `20260804100000_user_profile_github_account.sql`,
`20260804110000_real_worktree_visibility_grants.sql`, and
`20260804120000_github_account_reassignment.sql` before deploying the
real-worktree runtime change. Apply
`20260807100000_indefinite_user_analytics_retention.sql` before deploying
ownership-scoped developer session deletion. It installs the monotonic profile
lock, delete enforcement trigger, and service-role-only protected purge RPC.
Apply `20260809190612_bug_reports.sql` before deploying the Bug Reports UI or
server routes; the migration also adds the partial error-log listing index and
updates stored role-policy defaults without materializing user overrides.
Apply `20260810130000_managed_error_diagnostics.sql` after the clipboard
analytics migration and before deploying diagnostic server/UI changes. It adds
nullable constrained classification columns, backfills existing error rows as
inferred without changing metadata, and adds the impact/action keyset index.
Apply `20260810182541_clear_managed_error_diagnostics.sql` before deploying the
snapshot-clear route. It installs the service-role-only, security-invoker RPC
and narrows the retention trigger bypass to the five Error Log actions within
that RPC's transaction-local scope; all other retention-locked analytics stay
protected.
Apply `20260816120000_refine_error_diagnostic_classification.sql` with or before
the matching runtime changes. It transactionally suspends classification
immutability, narrowly reclassifies exact tool-abort boilerplate, malformed
search regexes, refused browser targets, and unqualified request timeouts across
all users, updates only classification columns and their mirrored sanitized
metadata, preserves every event and resolution record, then restores the
immutability trigger.
The GitHub migration installs the service-role-only atomic reassignment
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
- Public Managed Remote authentication and API requests return `503` with
  `code: "managed_account_auth_required"` when the host has only local/shared
  password authentication. Loopback administration remains available so the
  preserved connector preset can be stopped or reconfigured.
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
- A valid legacy or link-gated `/tunnel/connect` exchange calls `prepareFreshTunnelLogin` before the
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
OpenCode correlation IDs, and UUIDs linking requested or diagnostic-resolution
events survive sanitization; free-form high-entropy metadata remains redacted.
Records may contain bounded prompt or clipboard text supplied by the actor,
tool name/state, logical branch, project-relative paths, Git SHA/PR metadata,
and outcomes. They never contain passwords, tokens, raw host paths, agent-read
file contents, assistant/tool output, or terminal I/O. Terminal audit is limited
to open and close lifecycle events. Session lifecycle outcomes are recorded as
`session.archived`, `session.unarchived`, and `session.deleted`; delete metadata
distinguishes upstream removal from ownership tombstoning so partial failure is
visible without storing session content.

## User analytics contract

- Managed administrators are excluded from detailed user analytics collection.
  Their human prompts, explicit file opens, and clipboard copies are not stored;
  security-relevant authentication, account, policy, and host-management audit
  events remain recorded.
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
  copy rows accept surface, kind, character count, optional relative path, and
  optional copied text. Text is sanitized, capped at 64 KiB, and stored in
  dedicated unindexed columns rather than aggregation metadata. Per-item
  results make partial failure retryable.
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
  an administrator and a visible human target profile. `session.deleted`
  appears in the Changes & Interactions feed with its success or partial-failure
  state, but it is not counted as a prompt, settings change, or separate
  active-time block.
- Interaction pages enrich only their visible clipboard rows with a sanitized
  512-character preview. `GET
  /api/admin/users/:userId/analytics/clipboard/:eventId` retrieves the bounded
  full text for one authorized row on demand. Range/daily aggregation, generic
  activity lists, and activity export explicitly exclude clipboard columns.
- Settings/profile/policy/project/access audits carry allowlisted field deltas.
  Booleans, numbers, roles, names, branches, defaults, and permission or
  capability states may include before/after values. Secrets, tokens, paths,
  URLs, prompt/template fields, and arbitrary JSON expose only changed keys or
  collection counts. Invitation rows carry their target user correlation.
- Once a managed non-admin user attempts an owned hard delete, every
  `activity_logs` row linked to that user through actor or target identity is
  retained indefinitely. The database trigger also protects rows delivered
  later by the durable audit outbox. `DELETE /api/admin/activity` calls the
  service-role purge RPC, preserves the purge event and protected rows, and
  returns `{ purged, deletedCount, protectedCount }`; administrators' own rows
  and never-locked users remain purgeable. Export reads every retained page
  instead of truncating at 10,000 rows; non-admin exports apply the same
  detailed-action removal and metadata stripping as the list.
- `DELETE /api/admin/users/:userId/analytics` requires an exact administrator,
  an explicit confirmation body, and a visible human target. It first records
  and flushes the administrative purge marker behind the durable outbox
  delivery barrier, then calls the service-role-only
  `devryan_purge_user_activity_logs` RPC. The RPC installs an exact-target,
  transaction-local retention bypass, deletes every actor- or target-linked row
  in the flushed snapshot regardless of retention locks, preserves the purge
  marker, and rolls back unless its zero-remaining-row postcondition holds.
  Direct deletes, global activity purges, and unrelated users remain protected.
  The response returns `{ purged, deletedCount, remainingCount: 0 }`. Events
  queued after the barrier remain as newer analytics instead of being lost in
  the clear snapshot.

Apply `20260810120000_clipboard_analytics_text.sql` before
`20260810130000_managed_error_diagnostics.sql`. Both migrations are additive;
historical copy rows remain metadata-only because their text cannot be
reconstructed, while diagnostic backfill preserves existing audit metadata.
Apply `20260830023917_purge_user_analytics.sql`, followed by
`20260830123704_admin_clear_all_user_analytics.sql`, before exposing the
per-user Clear Analytics action. The latter installs the exact-target trigger
bypass and complete-snapshot RPC contract. Both RPC revisions are security
invoker and grant execution exclusively to `service_role`.
