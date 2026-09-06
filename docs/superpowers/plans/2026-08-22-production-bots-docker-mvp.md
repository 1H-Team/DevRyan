# Production Bots Docker MVP Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a production-quality, macOS-first DevRyan Bots MVP in which private continuous conversations use DevRyan-selected OpenCode models, durable encrypted Supabase history, automatic layered memory, and policy-gated work inside isolated Docker computers.

**Architecture:** Electron remains the only v1 runtime owner and starts the existing web server in-process. Supabase is the encrypted multi-user control plane; per-channel OpenCode reasoning, per-scope Chromium computers, a restricted Docker supervisor, model egress, and a rebuildable retrieval index run in signed Docker images. Ordinary coding sessions and the existing managed OpenCode/browser paths remain unchanged; Bot execution uses a separate API, event stream, state model, and UI.

**Tech Stack:** Bun/Node 22, Electron 41, Express, React 19, Zustand 5, OpenCode 1.18.21 and `@opencode-ai/sdk/v2`, Supabase Auth/PostgREST/Storage/Postgres, Docker Desktop, Docker Engine API, Chromium/Playwright, SQLite FTS/local embeddings, AES-256-GCM, Tailwind v4, Base UI, Vitest/Bun test.

---

## Product and architecture decisions locked by review

This plan supersedes the submitted project-scoped hidden-agent plan. The following are requirements, not implementation options:

1. **Bots are deployment/team coworkers, not project entities.** A curated Bot Library may import reviewed snapshots from a project, upload, or connector, but no Bot is rooted in a repository, branch, worktree, `.git`, or live source mount.
2. **Bot reasoning is separate from ordinary DevRyan coding chat.** Normal DevRyan sessions continue to use the existing managed OpenCode runtime. Every Bot channel gets a scoped OpenCode runtime in Docker with only its private workspace, the Bot Library, and the Bot gateway tool.
3. **Docker is required for execution.** History and management remain readable without Docker. A send preflight fails before message/run creation with HTTP 503, code `bot_runtime_docker_unavailable`, and UI copy `Docker Desktop isn’t running.`
4. **Electron is the sole v1 owner.** Bot work and schedules run only while DevRyan is open. Electron and browser clients served by that same in-process server get the full UI. VS Code gets an explicit unsupported state and never starts a supervisor.
5. **macOS is the first supported host**, for Apple Silicon and Intel. Windows/Linux interfaces remain portable but are not advertised or accepted by the setup gate.
6. **Supabase is canonical.** Bot definitions, revisions, memberships, channels, encrypted messages, run/action state, routines, memory metadata, object metadata, and audit state live in service-only tables. There is no local JSON fallback for the Bots product.
7. **Private conversation model.** One continuous channel exists per user × Bot, with optional Reader/Collaborator ACLs. It renders as one timeline but rotates through bounded OpenCode execution segments and checkpoints internally.
8. **Automatic layered learning.** Every completed private run teaches automatically. A mandatory classifier routes reusable facts to shared Bot memory, user-specific/confidential facts to private user memory, and temporary facts to the channel summary. Raw transcripts never become shared memory. Managers alone can inspect or edit memory.
9. **Deleting a channel does not remove shared learning.** The confirmation must say this. Channel deletion removes encrypted transcript, private artifacts, summaries, and channel-private memory after policy checks; shared memories remain until a Manager forgets/tombstones them or the Bot is purged.
10. **Two explicit tenancy modes.** Team Bots share one computer/browser profile and team credential set; Personalized Bots use one computer/profile/credential scope per user. Reasoning/workspace remains per channel in both modes so private files and transcripts cannot leak through a shared filesystem.
11. **One leased run per computer scope.** Team Bot work is FIFO across all member channels. Personalized Bots have independent per-user queues. No two runs can control the same browser concurrently.
12. **Tiered action policy.** Deny/prompt/allow rules bind Bot, revision, action, target/account, initiator, limits, and approval class. Low-risk actions may be self-confirmed; sensitive actions require another Operator; critical actions require a Manager.
13. **Framework-only native connectors in MVP.** The typed connector contract ships, but no Gmail/Ads connector ships. External work uses the governed browser. Consequently, generic browser writes can be `unknown` after interruption and must be reconciled by a person; the plan must never claim native exactly-once guarantees for arbitrary websites.
14. **Computer network is broad by explicit choice.** The visible computer may reach public internet and LAN. The OpenCode reasoning container may reach only the selected model hosts through the egress proxy and the authenticated DevRyan gateway; otherwise the gateway could be bypassed.
15. **Model policy is revision-owned.** Each active revision pins a primary OpenCode provider/model/reasoning configuration and ordered fallbacks. Users cannot switch models. In-flight runs stay pinned; every future chat and routine run uses the newly activated revision automatically.
16. **Lifecycle is Draft → Active ↔ Paused → Retired, plus separate Purge.** Pause and retire preserve history, memory, files, credentials, and volumes. Purge is granular, typed, audited, and destructive.
17. **Browser visibility is foundational, not fully polished.** MVP includes authenticated screencast/control protocol, an admin diagnostic preview, and pause/take/return-control behavior. Full product-grade browser polish is outside the MVP cut.
18. **No continuous browser recording.** Live frames are ephemeral. Policy-selected high-risk actions may retain redacted before/after evidence; structured receipts are preferred.
19. **Local secrets stay local.** Connector secrets use an Electron/OS-sealed vault. Bot runtimes receive short-lived capability tokens. Supabase stores only non-secret credential metadata. Browser cookies remain in scoped Docker volumes.
20. **Private content is envelope-encrypted before Supabase.** Message bodies, summaries, memory content, and object keys require the Mac’s OS-sealed deployment key. Supabase operators see routing metadata and ciphertext, not plaintext.
21. **Retrieval is local and rebuildable.** Encrypted source records remain canonical in Supabase; decrypted search indexes live in Docker and can be rebuilt. Docker-off history is readable, but new Bot execution/retrieval is unavailable.
22. **Routines are structured.** Conversational authoring produces a Manager-reviewed schedule contract with timezone, tools, limits, approval, timeout, and missed-run policy (`skip`, `run_once`, `replay_capped`). Writes default to `run_once` plus approval after resume.
23. **Interrupted writes do not replay blindly.** Durable idempotency/action state allows safe read retries. Unknown writes enter `needs_reconciliation` until provider/browser evidence or an Operator resolves them.
24. **Audit is sanitized and retained one year by default.** Retention is globally configurable with a floor; transcript deletion never deletes action/policy/audit facts.
25. **Recovery is explicit.** Safe passphrase-encrypted exports include the deployment key, configuration manifest, and selected files. Connector secrets and browser profiles are opt-in high-risk export sections.

## MVP boundary

### Included

- macOS Docker Runtime setup/repair/update wizard using signed, digest-pinned `DevRyan` images;
- deployment-level Bot catalog, immutable revisions, lifecycle, memberships, Reader/Collaborator channel ACLs, and Team/Personalized tenancy;
- one continuous private channel per owner/Bot with encrypted, cursor-paged Supabase history;
- per-channel OpenCode reasoning containers, bounded checkpoints, pinned model/fallback policy, and private workspaces;
- separate persistent Chromium computer scopes, one-run leases, FIFO queues, browser action gateway, diagnostic screencast, and take-the-wheel control;
- policy/approval/action state machines, idempotency, interruption reconciliation, sanitized audit, and one-year retention;
- encrypted Supabase Storage objects, private artifacts, explicit publish-to-Library, reviewed/versioned Library refresh;
- asynchronous layered memory, Manager-only memory console, and Docker-local rebuildable retrieval;
- structured routines with app-bound scheduling and conservative missed-run recovery;
- Draft Test Lab simulation plus explicit live canary;
- Electron + same-server web UI with a Bot Operations rail and no repository/Git/File controls in Bot mode;
- lifecycle pause/retire/purge and safe/optional-secret recovery bundles.

### Explicitly outside the MVP

- background execution while Electron is closed;
- Windows/Linux host support;
- VS Code execution or Bot management;
- CopilotKit Intelligence, AG-UI, or another hosted coworker dependency;
- Gmail, Google Ads, Meta Ads, or any first-party native connector implementation;
- arbitrary MCP attachment, direct shell/network access, Git operations, coding agents, live project mounts, or bot-to-bot delegation;
- continuous browser video retention;
- polished end-user Browser Panel parity beyond the diagnostic preview/control protocol;
- cross-machine secret synchronization or automatic remote runtime hosting.

## Trust boundaries and runtime topology

```text
Electron main process (sole owner)
├─ OS-sealed deployment key + connector vault
├─ fixed Docker setup/update manager
└─ in-process packages/web server
   ├─ authenticated Bot APIs + principal checks
   ├─ Supabase encrypted persistence + Storage
   ├─ run dispatcher / routine scheduler
   ├─ policy + approval + action gateway
   └─ private loopback gateway for Docker runtimes

Docker Desktop
├─ devryan-bot-supervisor       # only service with Docker socket; fixed Bot verbs
├─ devryan-bot-egress           # authenticated model-host allowlist proxy
├─ devryan-bot-indexer          # local rebuildable memory/library index
├─ N × devryan-bot-opencode     # one per channel, stopped when idle
└─ M × devryan-bot-computer     # Team: one/Bot; Personalized: one/user/Bot
```

The supervisor alone receives the Docker socket. The web server never receives that socket and can only request `ensure`, `status`, `stop`, `reset`, and `list` for namespaced Bot resources. Every dynamic container carries deployment, Bot, channel/user scope, image digest, and owner labels. No runtime container receives the socket.

`reasoningScopeKey = channelId` for both tenancy modes. `computerScopeKey = botId` for Team Bots and `computerScopeKey = botId:userId` for Personalized Bots. Test Lab uses a separate `test:botId:userId` computer/profile. Hash these values for Docker names; keep canonical IDs only in labels and server state.

## Persistence model

Create `supabase/migrations/20260822120000_production_bots.sql` and `supabase/tests/production_bots.test.sql`. All new relations are RLS-enabled, RLS-forced, revoked from `public`, `anon`, and `authenticated`, and granted only to `service_role`, matching `20260802195944_devryan_multi_user.sql`.

| Relation | Purpose and required constraints |
|---|---|
| `bots` | UUID identity, lifecycle, tenancy, active revision, created-by, timestamps, retired timestamp; active revision FK is deferred to avoid insert cycle. |
| `bot_revisions` | Immutable revision number and structured JSON contract, compiled hash, creator, activation timestamp; unique `(bot_id, revision_number)` and `(bot_id, compiled_hash)`. Activated rows reject update except retirement metadata. |
| `bot_memberships` | `(bot_id,user_id)` role `member|operator|manager`, active/revoked timestamps; at least one active Manager enforced by service mutation transaction. |
| `bot_channels` | Owner-private continuous channel, lifecycle, current checkpoint number, encrypted summary envelope, last-message timestamp; unique active owner channel `(bot_id,owner_user_id)`. |
| `bot_channel_acl` | Reader/Collaborator grants to existing active Bot members, inviter, grant/revoke timestamps; owner is implicit and cannot be removed through this table. |
| `bot_messages` | Client-stable ID, channel, run, actor, role, monotonically allocated channel sequence, encrypted body envelope, attachment count, created/finalized timestamps; immutable after finalization. |
| `bot_objects` | Encrypted Supabase Storage object metadata, owner channel/Bot, visibility `private|library`, ciphertext hash/size, wrapped key, content type, provenance, deleted timestamp. |
| `bot_runs` | Idempotent run identity, channel/revision/model snapshot, computer scope, queue sequence, OpenCode segment/session IDs, state, lease generation, interruption/reconciliation fields, timestamps. |
| `bot_action_attempts` | Exact canonical action hash, idempotency key, run, tool/action/target, encrypted args, risk/approval class, state, execution receipt, unknown outcome, reconciliation decision. |
| `bot_approvals` | Action hash, approver, decision, expiry, exact revision and args digest; unique valid decision per action/approver. |
| `bot_credentials` | Non-secret provider/kind/scope metadata, local vault reference, owner/team scope, status/revocation; no token, cookie, refresh secret, or key bytes. |
| `bot_routines` | Structured schedule, timezone, missed policy/cap, status, next/last occurrence, current active-revision behavior, creator/manager. |
| `bot_routine_occurrences` | Atomic occurrence claim, scheduled time, run link, recovery disposition, unique `(routine_id,scheduled_for)`. |
| `bot_memories` | Current logical memory identity, scope `shared|user_private`, subject key, encrypted content, sensitivity/confidence, active version, tombstone. |
| `bot_memory_versions` | Immutable encrypted memory versions, classifier metadata, creator kind, timestamps. |
| `bot_memory_sources` | Memory version to channel/run/message provenance. Channel deletion may tombstone source metadata but does not delete shared memory. |
| `bot_library_sources` | Reviewed source descriptor, exclusions, source provenance, current published version. Host paths are encrypted and never returned to non-Managers. |
| `bot_library_versions` | Immutable version/diff manifest, encrypted object references, publication actor/time. Runs snapshot the version IDs they use. |
| `bot_audit_events` | Append-only sanitized Bot event ledger with actor/target/action/result and bounded metadata; no message body, secret, raw browser frame, or host path. |
| `bot_eval_cases` / `bot_eval_runs` | Manager-owned Draft test inputs, expected structured outcomes, simulation/live-canary mode, result and revision pin. |

The migration also creates:

- private Storage bucket `devryan-bot-objects`;
- `devryan_allocate_bot_message_sequence(channel_id)`;
- `devryan_claim_bot_run(computer_scope, runtime_owner, lease_until)` using `FOR UPDATE SKIP LOCKED`;
- `devryan_claim_bot_routine_occurrence(routine_id, scheduled_for, occurrence_id)`;
- `devryan_activate_bot_revision(bot_id, revision_id, actor_id)`;
- `devryan_prune_bot_audit(retain_after)` with a hard minimum retention floor;
- indexes for active memberships, channel owner/activity, cursor paging, queued runs by computer scope, pending approvals, due routines, active memories by scope, memory provenance, library versions, and audit time/target.

## Stable API and error contract

All mutation routes require the existing CSRF contract. Server errors use `{ error, code, details? }` with these stable codes:

```js
export const BOT_ERROR_CODES = Object.freeze({
  unavailable: 'bots_unavailable',
  migrationRequired: 'bot_schema_migration_required',
  dockerNotInstalled: 'bot_runtime_docker_not_installed',
  dockerUnavailable: 'bot_runtime_docker_unavailable',
  runtimeSetupRequired: 'bot_runtime_setup_required',
  runtimeUpdateRequired: 'bot_runtime_update_required',
  botPaused: 'bot_paused',
  botRetired: 'bot_retired',
  membershipRequired: 'bot_membership_required',
  managerRequired: 'bot_manager_required',
  channelForbidden: 'bot_channel_forbidden',
  modelUnavailable: 'bot_model_unavailable',
  approvalRequired: 'bot_approval_required',
  actionNeedsReconciliation: 'bot_action_needs_reconciliation',
  revisionConflict: 'bot_revision_conflict',
});
```

Primary routes:

- `GET /api/bots/capabilities` — Supabase/Electron/Docker/image/index status and exact unavailable code;
- `GET|POST /api/bots`, `GET|PATCH /api/bots/:botId`, lifecycle endpoints, revision CRUD/activate, memberships, policies, credentials metadata, and Test Lab;
- `POST /api/bots/:botId/channel` — return/create the owner’s continuous channel;
- `GET /api/bot-channels/:channelId/messages?cursor=&limit=`;
- `POST /api/bot-channels/:channelId/messages` — preflight, persist user message + queued run atomically, then dispatch;
- channel ACL, archive/delete, object upload/download/publish, and Library version routes;
- run cancel/status/reconcile, approvals, queue status, routines, memories, audit, export/import;
- `GET /api/bots/events` — principal-filtered Bot-only SSE; never route Bot events through the normal OpenCode session reducer;
- private authenticated runtime endpoints on a separate loopback listener for OpenCode tool calls, egress policy refresh, computer control, and index operations.

## Implementation

### Phase 1: Contracts, schema, and validation ownership

#### Task 1: Add the dependency-free Bots runtime contract and state machines

**Files:**
- Create: `packages/bots-runtime/package.json`
- Create: `packages/bots-runtime/index.js`
- Create: `packages/bots-runtime/index.d.ts`
- Create: `packages/bots-runtime/contract.js`
- Create: `packages/bots-runtime/lifecycle.js`
- Create: `packages/bots-runtime/policy.js`
- Create: `packages/bots-runtime/run-state.js`
- Create: `packages/bots-runtime/routines.js`
- Create: `packages/bots-runtime/contract.test.js`
- Create: `packages/bots-runtime/lifecycle.test.js`
- Create: `packages/bots-runtime/policy.test.js`
- Create: `packages/bots-runtime/run-state.test.js`
- Create: `packages/bots-runtime/routines.test.js`
- Create: `packages/bots-runtime/codemap.md`
- Create: `packages/bots-runtime/DOCUMENTATION.md`
- Modify: `package.json`
- Modify: `scripts/validate.mjs`
- Modify: `scripts/test-suite-contract.test.mjs`
- Modify: `scripts/test-runner-utils.test.mjs`
- Modify: `scripts/feature-test-matrix.mjs`
- Modify: `scripts/bump-version.mjs`
- Modify: `packages/codemap.md`
- Modify: `CODEMAP.md`

- [ ] Write RED tests for lifecycle transitions, immutable active revisions, role/ACL decisions, Team/Personalized scope keys, one-lease run admission, approval classes, exact action hashing, routine missed-run policies, and terminal/unknown write states.
- [ ] Implement stable JSON-only contracts. Use explicit enums and canonical JSON hashing; reject unknown fields at every server boundary.

```js
export const BOT_LIFECYCLES = Object.freeze(['draft', 'active', 'paused', 'retired']);
export const BOT_TENANCIES = Object.freeze(['team', 'personalized']);
export const BOT_MEMBER_ROLES = Object.freeze(['member', 'operator', 'manager']);
export const BOT_RUN_STATES = Object.freeze([
  'queued', 'starting', 'running', 'waiting_approval',
  'needs_reconciliation', 'completed', 'failed', 'cancelled', 'interrupted',
]);
export const BOT_ACTION_STATES = Object.freeze([
  'proposed', 'pending_approval', 'approved', 'executing',
  'succeeded', 'failed', 'unknown', 'reconciled', 'denied',
]);

export const resolveComputerScopeKey = ({ botId, tenancy, ownerUserId }) =>
  tenancy === 'team' ? `bot:${botId}` : `bot:${botId}:user:${ownerUserId}`;
export const resolveReasoningScopeKey = ({ channelId }) => `channel:${channelId}`;
```

- [ ] Add the package to the root full/affected validation gates and package-version scripts; prove a Bots core change runs Bots, web and ElectronUI dependents.
- [ ] Run `bun run --cwd packages/bots-runtime test` and `bun run test:scripts`; expect PASS.
- [ ] Commit `feat(bots): add runtime contracts and state machines`.

#### Task 2: Add the service-only Supabase schema and compatibility gate

**Files:**
- Create: `supabase/migrations/20260822120000_production_bots.sql`
- Create: `supabase/tests/production_bots.test.sql`
- Create: `packages/web/server/lib/multi-user/bots-migration.test.js`
- Modify: `packages/web/server/lib/multi-user/auth-compat.js`
- Modify: `packages/web/server/lib/multi-user/auth-compat.test.js`
- Modify: `packages/web/server/lib/multi-user/DOCUMENTATION.md`
- Modify: `packages/web/server/lib/multi-user/codemap.md`

- [ ] Write pgTAP/JS RED tests proving table constraints, service-only privileges, immutable activated revisions, unique continuous owner channels, ACL membership checks, atomic FIFO run claims, atomic routine occurrence claims, and audit-retention floor.
- [ ] Implement the persistence model and RPCs listed above. Use `devryan_set_updated_at()` for mutable control rows; immutable history/version/audit rows receive no update trigger.
- [ ] Add `PRODUCTION_BOTS_MIGRATION = '20260822120000'` and missing-relation/function detection. Managed hosts must return the existing 503 migration envelope with `requiredMigration`; never run with a partial Bot schema.
- [ ] Run the sanctioned local workflow:

```bash
bunx supabase db reset --local
bunx supabase test db --local
bun run --cwd packages/web test -- bots-migration
```

Expected: migration applies from zero, pgTAP passes, and the compatibility test maps stale schema to HTTP 503.
- [ ] Commit `feat(bots): add Supabase control-plane schema`.

### Phase 2: Electron ownership, encryption, and Docker installation

#### Task 3: Add the OS-sealed deployment key and local credential vault

**Files:**
- Create: `packages/electron/bot-secret-store.mjs`
- Create: `packages/electron/tests/bot-secret-store.test.mjs`
- Create: `packages/web/server/lib/bots/encryption.js`
- Create: `packages/web/server/lib/bots/encryption.test.js`
- Create: `packages/web/server/lib/bots/credential-vault.js`
- Create: `packages/web/server/lib/bots/credential-vault.test.js`
- Modify: `packages/electron/main.mjs`
- Modify: `packages/electron/package.json`
- Modify: `packages/electron/codemap.md`

- [ ] Write RED tests for first-run key creation, Electron `safeStorage` sealing/unsealing, unavailable OS encryption, AES-256-GCM round trips, wrong-key rejection, unique IVs, key IDs, atomic 0600 vault writes, secret redaction, rotation metadata, and no secret in Supabase-shaped records.
- [ ] Implement one random 32-byte deployment key sealed by Electron `safeStorage` under `<OPENCHAMBER_DATA_DIR>/bots/keys/deployment-key.v1`. Inject a narrow `getBotEncryptionKey()` callback into the in-process server; never expose it over IPC/HTTP or log it.
- [ ] Implement versioned envelopes:

```js
{
  version: 1,
  algorithm: 'aes-256-gcm',
  keyId: 'deployment-v1',
  iv: '<base64>',
  tag: '<base64>',
  ciphertext: '<base64>'
}
```

- [ ] Implement the native connector vault under `<OPENCHAMBER_DATA_DIR>/bots/vault/credentials.v1.json`; even though MVP ships no connector, policy/tests require create/read/rotate/revoke without putting plaintext in runtime state.
- [ ] Run `bun run --cwd packages/electron test` and the focused web encryption/vault tests; expect PASS.
- [ ] Commit `feat(bots): add OS-sealed encryption and credential vault`.

#### Task 4: Add fixed Docker runtime setup, status, repair, and update management

**Files:**
- Create: `packages/electron/bot-runtime-manager.mjs`
- Create: `packages/electron/bot-runtime-manifest.mjs`
- Create: `packages/electron/tests/bot-runtime-manager.test.mjs`
- Create: `packages/electron/resources/bot-runtime/images.dev.json`
- Create: `docker/bots/compose.yml`
- Modify: `packages/electron/main.mjs`
- Modify: `packages/electron/preload.mjs`
- Modify: `packages/electron/package.json`
- Modify: `packages/electron/quit-cleanup.mjs`
- Modify: `packages/electron/quit-risk.mjs`

- [ ] Write RED tests with a fake process runner for Docker-not-installed, Docker-installed-but-stopped, setup-required, digest mismatch, healthy, degraded, staged update, rollback, and idempotent repair. Assert argv arrays exactly; no user string enters a shell command.
- [ ] Resolve Docker only from validated absolute macOS candidates/PATH. Use `docker version`, `docker compose`, `docker pull`, `docker image inspect`, and the fixed compose project `devryan-bots`; never auto-install or auto-launch Docker Desktop.
- [ ] Make development use local `DevRyan` image tags from `images.dev.json`. Production accepts only a generated release manifest containing immutable OCI digests and matching `arm64|amd64` architecture; fail packaging if it is absent.
- [ ] Expose local-only Electron commands `desktop_bot_runtime_status`, `desktop_bot_runtime_setup`, `desktop_bot_runtime_repair`, `desktop_bot_runtime_update`, and `desktop_bot_runtime_rollback`. Browser clients may read server status but only Electron can mutate Docker setup.
- [ ] Extend quit-risk/cleanup with active Bot run, pending approval, and checkpoint status. Normal quit offers wait/cancel/quit; cleanup checkpoints runs, stops dispatcher/index requests, and leaves named volumes intact.
- [ ] Run Electron tests and `bun run type-check:electron`; expect PASS.
- [ ] Commit `feat(bots): manage the local Docker runtime from Electron`.

### Phase 3: Signed container services and confinement

#### Task 5: Build the restricted Docker supervisor and model-egress proxy

**Files:**
- Create: `packages/bot-supervisor/package.json`
- Create: `packages/bot-supervisor/src/server.js`
- Create: `packages/bot-supervisor/src/docker.js`
- Create: `packages/bot-supervisor/src/names.js`
- Create: `packages/bot-supervisor/src/auth.js`
- Create: `packages/bot-supervisor/src/server.test.js`
- Create: `packages/bot-supervisor/src/docker.test.js`
- Create: `packages/bot-supervisor/src/names.test.js`
- Create: `packages/bot-supervisor/src/auth.test.js`
- Create: `packages/bot-supervisor/Dockerfile`
- Create: `packages/bot-supervisor/codemap.md`
- Create: `packages/bot-supervisor/DOCUMENTATION.md`
- Create: `packages/bot-egress/package.json`
- Create: `packages/bot-egress/src/server.js`
- Create: `packages/bot-egress/src/connect-policy.js`
- Create: `packages/bot-egress/src/token.js`
- Create: `packages/bot-egress/src/server.test.js`
- Create: `packages/bot-egress/src/connect-policy.test.js`
- Create: `packages/bot-egress/src/token.test.js`
- Create: `packages/bot-egress/Dockerfile`
- Create: `packages/bot-egress/codemap.md`
- Create: `packages/bot-egress/DOCUMENTATION.md`
- Modify: `docker/bots/compose.yml`
- Modify: `package.json`

- [ ] Test supervisor bearer auth, deployment labels, deterministic hashed names, ownership refusal, concurrent ensure, ephemeral loopback ports, image-digest replacement preserving volumes, stop, granular reset, resource limits, and Docker-unavailable errors.
- [ ] Give the supervisor only fixed verbs: `ensure reasoning`, `ensure computer`, `status`, `stop`, `reset`, and `list owned`. It may not proxy arbitrary Docker Engine requests. Only this container mounts `/var/run/docker.sock`; document that even a read-only socket is root-equivalent.
- [ ] Apply `no-new-privileges`, drop all capabilities, non-root users, PID/memory/CPU limits, 1 GiB Chromium shared memory, loopback-only published ports, named volumes, and deployment/Bot/scope/image labels to dynamic containers.
- [ ] Test the egress proxy’s authenticated CONNECT/HTTP policy. A runtime token permits only the active revision’s normalized model hosts; loopback, private/LAN, metadata, sibling-container, and arbitrary destinations are denied. The computer does not use this proxy, honoring the chosen broad internet/LAN policy.
- [ ] Run both package suites and one opt-in Docker integration group: `DEVRYAN_RUN_DOCKER_TESTS=1 bun test packages/bot-supervisor packages/bot-egress`.
- [ ] Commit `feat(bots): add restricted Docker supervisor and egress`.

#### Task 6: Build the scoped OpenCode and persistent computer images

**Files:**
- Create: `packages/bots-runtime/docker/opencode/Dockerfile`
- Create: `packages/bots-runtime/docker/opencode/entrypoint.sh`
- Create: `packages/bots-runtime/opencode/devryan-bot-tools.mjs`
- Create: `packages/bots-runtime/opencode/devryan-bot-tools.test.mjs`
- Create: `packages/bot-computer/package.json`
- Create: `packages/bot-computer/src/server.js`
- Create: `packages/bot-computer/src/auth.js`
- Create: `packages/bot-computer/src/profiles.js`
- Create: `packages/bot-computer/src/browser.js`
- Create: `packages/bot-computer/src/refs.js`
- Create: `packages/bot-computer/src/control.js`
- Create: `packages/bot-computer/src/screencast.js`
- Create: `packages/bot-computer/src/workspace.js`
- Create: `packages/bot-computer/src/server.test.js`
- Create: `packages/bot-computer/src/auth.test.js`
- Create: `packages/bot-computer/src/profiles.test.js`
- Create: `packages/bot-computer/src/browser.test.js`
- Create: `packages/bot-computer/src/refs.test.js`
- Create: `packages/bot-computer/src/control.test.js`
- Create: `packages/bot-computer/src/screencast.test.js`
- Create: `packages/bot-computer/src/workspace.test.js`
- Create: `packages/bot-computer/Dockerfile`
- Create: `packages/bot-computer/codemap.md`
- Create: `packages/bot-computer/DOCUMENTATION.md`
- Modify: `docker/bots/compose.yml`

- [ ] Pin `opencode-ai` to `1.18.21`. Run as non-root with separate `/data/opencode`, `/workspace`, and generated read-only `/runtime-config` mounts. Expose only OpenCode health/API on its internal port.
- [ ] Generate one Bot agent with file read/write/edit/search and `devryan_bot`; deny shell, terminal, Git, provider-native task delegation, existing `devryan_task`, direct browser/CDP, arbitrary MCP, and every unlisted tool. Add an export-shape test proving the plugin exports functions only.
- [ ] Make the plugin use the authenticated private gateway and exact run/channel/revision capability. It must not accept a caller-supplied Bot/user/channel identity and must return stable `DEVRYAN_BOT_*` codes.
- [ ] Implement the computer API with persistent Chromium profile volume, accessibility snapshot refs fenced by page generation, reviewed commands (`navigate`, `snapshot`, `click`, `fill`, `select`, `key`, `scroll`, `wait`, `upload`, `download`, `screenshot`, `close`), and no arbitrary JavaScript evaluation.
- [ ] Add authenticated ephemeral JPEG screencast plus control lease. Agent commands pause while a person holds control; `take`, `heartbeat`, and `return` are actor-attributed. Frames are never persisted by the computer service.
- [ ] Keep browser profile and scratch volume per computer scope. Clear scratch between Team Bot leases; move uploads/downloads through the gateway/object store so private channel artifacts never become shared by accident.
- [ ] Run unit tests and a fixture-browser integration test for login persistence, ref invalidation, concurrent-control refusal, profile reset, file transfer, and graceful Chromium flush.
- [ ] Commit `feat(bots): add scoped OpenCode and computer images`.

#### Task 7: Add the local retrieval-index image

**Files:**
- Create: `packages/bot-indexer/package.json`
- Create: `packages/bot-indexer/src/server.js`
- Create: `packages/bot-indexer/src/index-store.js`
- Create: `packages/bot-indexer/src/chunker.js`
- Create: `packages/bot-indexer/src/embeddings.js`
- Create: `packages/bot-indexer/src/search.js`
- Create: `packages/bot-indexer/src/server.test.js`
- Create: `packages/bot-indexer/src/index-store.test.js`
- Create: `packages/bot-indexer/src/chunker.test.js`
- Create: `packages/bot-indexer/src/embeddings.test.js`
- Create: `packages/bot-indexer/src/search.test.js`
- Create: `packages/bot-indexer/Dockerfile`
- Create: `packages/bot-indexer/codemap.md`
- Create: `packages/bot-indexer/DOCUMENTATION.md`
- Modify: `docker/bots/compose.yml`

- [ ] Test authenticated namespace isolation for shared Bot, user-private, and channel-only records; deterministic chunking; FTS ranking; vector ranking; hybrid merge; delete/rebuild; corrupt-index recovery; count and byte caps.
- [ ] Store decrypted index material only in the local Docker volume. Use SQLite FTS5 plus a locally cached compact Transformers.js embedding model; pin package/model inputs in the image build and record their hashes in the image SBOM. No plaintext chunk or embedding is uploaded to Supabase.
- [ ] Expose host-only `upsert`, `delete`, `search`, `rebuild`, and `status`; reasoning containers never query the index directly. The web server authorizes scope and injects only retrieved text into a run.
- [ ] Make the index disposable: deleting its volume changes status to `rebuild_required`, and a deterministic rebuild consumes decrypted authorized Supabase records without changing canonical versions.
- [ ] Run package and opt-in Docker rebuild/isolation tests; expect PASS.
- [ ] Commit `feat(bots): add local rebuildable retrieval index`.

### Phase 4: Server control plane and encrypted persistence

#### Task 8: Add the focused Bots server module, Supabase repositories, and object store

**Files:**
- Create: `packages/web/server/lib/bots/index.js`
- Create: `packages/web/server/lib/bots/runtime.js`
- Create: `packages/web/server/lib/bots/routes.js`
- Create: `packages/web/server/lib/bots/validation.js`
- Create: `packages/web/server/lib/bots/store.js`
- Create: `packages/web/server/lib/bots/blob-store.js`
- Create: `packages/web/server/lib/bots/authorization.js`
- Create: `packages/web/server/lib/bots/audit-retention.js`
- Create: `packages/web/server/lib/bots/routes.test.js`
- Create: `packages/web/server/lib/bots/validation.test.js`
- Create: `packages/web/server/lib/bots/store.test.js`
- Create: `packages/web/server/lib/bots/blob-store.test.js`
- Create: `packages/web/server/lib/bots/authorization.test.js`
- Create: `packages/web/server/lib/bots/audit-retention.test.js`
- Create: `packages/web/server/lib/bots/codemap.md`
- Create: `packages/web/server/lib/bots/DOCUMENTATION.md`
- Modify: `packages/web/server/lib/multi-user/runtime.js`
- Modify: `packages/web/server/lib/multi-user/runtime.auth.test.js`
- Modify: `packages/web/server/lib/multi-user/supabase-client.js`
- Modify: `packages/web/server/lib/multi-user/supabase-client.test.js`
- Modify: `packages/web/server/index.js`
- Modify: `packages/web/server/lib/codemap.md`

- [ ] Extend the server-only Supabase client with private Storage upload/download/delete operations, strict response-size/time limits, and no signed public URLs.
- [ ] Implement repositories for every table with explicit selects, cursor paging, optimistic revision checks, transaction/RPC boundaries, and ciphertext-only payload logging. Do not spread arbitrary request JSON into Supabase writes.
- [ ] Instantiate `createBotsRuntime` inside the multi-user composition root so it receives only `{supabase,audit,principal policy,dataDirectory,botHost,encryption}`. The 5,000-line `multi-user/runtime.js` gains composition calls, not Bot domain logic.
- [ ] Enforce per-Bot Member/Operator/Manager roles, active membership, channel ACL, owner privacy, and audited global-admin break-glass. Managers do not automatically gain transcript access. Reader cannot send; Collaborator may send under normal policy.
- [ ] Implement encrypted object upload with MIME allowlist, magic-byte verification, bounded size, SHA-256 ciphertext integrity, per-object random key, wrapped key, private Storage bucket, and exact ACL checks. Publish-to-Library creates a new immutable object/version.
- [ ] Add capabilities/status route. Supabase absent, non-Electron owner, Docker missing/stopped, setup required, image update, index rebuilding, and healthy states must be distinguishable.
- [ ] Add one-year Bot audit pruning with a configurable floor and content-free payload validation.
- [ ] Run `bun run --cwd packages/web test` and `bun run validate:affected`; expect PASS.
- [ ] Commit `feat(bots): add encrypted server control plane`.

#### Task 9: Add Docker/OpenCode adapters and scoped model credential brokering

**Files:**
- Create: `packages/web/server/lib/bots/docker-provider.js`
- Create: `packages/web/server/lib/bots/opencode-provider.js`
- Create: `packages/web/server/lib/bots/config-compiler.js`
- Create: `packages/web/server/lib/bots/model-credential-broker.js`
- Create: `packages/web/server/lib/bots/gateway-host.js`
- Create: `packages/web/server/lib/bots/docker-provider.test.js`
- Create: `packages/web/server/lib/bots/opencode-provider.test.js`
- Create: `packages/web/server/lib/bots/config-compiler.test.js`
- Create: `packages/web/server/lib/bots/model-credential-broker.test.js`
- Create: `packages/web/server/lib/bots/gateway-host.test.js`
- Modify: `packages/web/server/lib/opencode/auth.js`
- Create: `packages/web/server/lib/opencode/auth.test.js`
- Modify: `packages/web/server/index.js`
- Modify: `packages/web/server/lib/opencode/shutdown-runtime.js`
- Modify: `packages/web/server/lib/opencode/shutdown-runtime.test.js`

- [ ] Implement a typed provider over Electron’s Bot runtime callbacks. The web server can inspect/ensure scoped resources but cannot issue raw Docker commands.
- [ ] Compile immutable revision config into a channel runtime directory. The compiled hash includes standing role, model/fallbacks, reasoning settings, file tool policy, gateway plugin version, Library versions, and memory policy.
- [ ] Read only the selected provider auth record from the host OpenCode auth source. Materialize it to an ephemeral 0600 scoped auth directory for the container, ingest a refreshed record back into the OS-sealed local vault, and remove plaintext on stop. Never mount/copy the complete host auth store.
- [ ] At run start, select primary then ordered fallback only if catalog, credential, and egress host validation all pass. Record the chosen model in `bot_runs`. If none pass, return `bot_model_unavailable`; do not use `ModelRecoveryCard` or permit a user override.
- [ ] Start a random-token private loopback gateway before Bot containers. Enforce body limits, Docker-origin expectations, exact scoped bearer claims, and graceful shutdown. Never log bearer/model credentials.
- [ ] Add Bots runtime shutdown to the existing graceful shutdown sequence before ordinary OpenCode/server teardown.
- [ ] Run focused adapter/auth/shutdown tests; expect PASS.
- [ ] Commit `feat(bots): connect scoped OpenCode runtimes`.

### Phase 5: Channels, runs, gateway actions, and live events

#### Task 10: Implement continuous channels, segmented OpenCode runs, and FIFO leases

**Files:**
- Create: `packages/web/server/lib/bots/channels.js`
- Create: `packages/web/server/lib/bots/context-assembler.js`
- Create: `packages/web/server/lib/bots/run-dispatcher.js`
- Create: `packages/web/server/lib/bots/run-recovery.js`
- Create: `packages/web/server/lib/bots/event-stream.js`
- Create: `packages/web/server/lib/bots/channels.test.js`
- Create: `packages/web/server/lib/bots/context-assembler.test.js`
- Create: `packages/web/server/lib/bots/run-dispatcher.test.js`
- Create: `packages/web/server/lib/bots/run-recovery.test.js`
- Create: `packages/web/server/lib/bots/event-stream.test.js`
- Modify: `packages/web/server/lib/bots/routes.js`
- Modify: `packages/web/server/lib/bots/runtime.js`

- [ ] Test owner channel idempotency, Reader/Collaborator access, client message idempotency, Docker preflight before any write, Team FIFO across users, Personalized independent queues, one lease per computer scope, cancellation, timeout, and restart reconciliation.
- [ ] `POST /messages` performs authorization/lifecycle/model/runtime preflight first. Only then atomically insert the user message and queued run. A 503 leaves the composer text untouched and creates no message, run, lease, or optimistic ghost.
- [ ] Build each run context from active revision, latest encrypted checkpoint, bounded recent messages, shared memory, user-private memory, and authorized Library chunks. Start a new OpenCode segment when revision changes, provider-reported context reaches 60%, or 40 completed user turns have accumulated; keep the product timeline continuous.
- [ ] Persist user messages immediately and coalesced assistant checkpoints at no more than 2 writes/second; finalize immutable assistant content on terminal state. Resume clients from Supabase sequence, not OpenCode history.
- [ ] Publish principal-filtered Bot SSE events from a separate event runtime. Unauthorized users receive no Bot/channel IDs. Reconnect loads a snapshot then applies monotonic event sequences.
- [ ] On process/runtime loss, reconcile OpenCode segment and action ledger. Read-only runs may resume. Unknown browser writes enter `needs_reconciliation`; never replay the prompt/action automatically.
- [ ] Run focused channel/queue/restart tests with controlled promise interleavings; expect PASS.
- [ ] Commit `feat(bots): add durable channels and run dispatch`.

#### Task 11: Implement the fail-closed action gateway, approvals, browser control, and connector contract

**Files:**
- Create: `packages/web/server/lib/bots/action-gateway.js`
- Create: `packages/web/server/lib/bots/policy-engine.js`
- Create: `packages/web/server/lib/bots/approval-service.js`
- Create: `packages/web/server/lib/bots/browser-service.js`
- Create: `packages/web/server/lib/bots/connector-registry.js`
- Create: `packages/web/server/lib/bots/evidence-service.js`
- Create: `packages/web/server/lib/bots/action-gateway.test.js`
- Create: `packages/web/server/lib/bots/policy-engine.test.js`
- Create: `packages/web/server/lib/bots/approval-service.test.js`
- Create: `packages/web/server/lib/bots/browser-service.test.js`
- Create: `packages/web/server/lib/bots/connector-registry.test.js`
- Create: `packages/web/server/lib/bots/evidence-service.test.js`
- Modify: `packages/web/server/lib/bots/routes.js`
- Modify: `packages/web/server/lib/bots/event-stream.js`

- [ ] Define a connector interface now, with zero registered production connectors: `describeActions`, `validate`, `authorize`, `execute`, `reconcile`, and `revoke`. Tests prove an unregistered connector cannot execute.
- [ ] Evaluate deny before prompt/allow. Bind every decision to canonical action hash, Bot/revision/run, credential/computer scope, target, initiator, limits, and expiry. Approval of changed args/revision/target is invalid.
- [ ] Enforce requester confirmation for low risk, another Operator for sensitive actions, and Manager approval for critical actions. Purge, credential export, and broad autonomy cannot be self-approved.
- [ ] For browser MVP, permit read operations separately from interaction grants. Potentially mutating clicks/fills/uploads require a bounded origin/goal/operation capability; submit/send/publish-like controls default to prompt. Be explicit in UI/audit that arbitrary websites cannot provide native exactly-once receipts.
- [ ] Implement durable action states and idempotency. Safe reads retry. A transport loss after a browser mutation becomes `unknown`; Operator reconciliation can mark complete, retry as a new action, or abandon.
- [ ] Proxy screencast and human control without persisting frames. Policy-selected evidence captures only bounded redacted target screenshots with expiry and Manager access.
- [ ] Test policy precedence, approval expiry/separation of duties, action-hash mismatch, duplicate execution, unknown outcomes, take/return control, and selective evidence retention.
- [ ] Commit `feat(bots): add policy-gated browser action gateway`.

### Phase 6: Bot catalog, chat, and operations UI

#### Task 12: Add Bot API clients and isolated Zustand projections

**Files:**
- Create: `packages/ui/src/lib/botsApi.ts`
- Create: `packages/ui/src/lib/botsDesktopApi.ts`
- Create: `packages/ui/src/stores/useBotsStore.ts`
- Create: `packages/ui/src/stores/useBotChannelStore.ts`
- Create: `packages/ui/src/stores/useBotOperationsStore.ts`
- Create: `packages/ui/src/stores/useBotsStore.test.ts`
- Create: `packages/ui/src/stores/useBotChannelStore.test.ts`
- Create: `packages/ui/src/stores/useBotOperationsStore.test.ts`
- Create: `packages/ui/src/apps/BotsEventOwner.tsx`
- Modify: `packages/ui/src/apps/AppEffects.tsx`
- Modify: `packages/ui/src/stores/codemap.md`
- Modify: `packages/ui/src/stores/DOCUMENTATION.md`

- [ ] Add plain HTTP clients preserving stable server codes and CSRF behavior. Do not add a first-of-kind `RuntimeAPIs` entity family.
- [ ] Keep catalog/revisions/memberships in low-frequency `useBotsStore`; normalized paged channel messages in `useBotChannelStore`; queue/run/approval/computer metadata in `useBotOperationsStore`. Preserve references on no-op events and expose channel/run leaf selectors.
- [ ] Keep screencast frames out of Zustand. The diagnostic component owns its WebSocket/canvas directly and stores only low-frequency connection/control state.
- [ ] Reconcile Bot SSE snapshot + sequence, drop stale events, and reset principal-scoped data on logout/account change. Never route into `sync-context.tsx` or clone ordinary session/message/part branches.
- [ ] Test unrelated-channel render isolation, pagination merge, optimistic client IDs, 503 rollback with composer retention, reconnect replay, ACL revocation, and logout cleanup.
- [ ] Run UI focused tests; expect PASS.
- [ ] Commit `feat(bots): add Bot client stores and event sync`.

#### Task 13: Add the Bot sidebar, continuous chat view, and Bot Operations rail

**Files:**
- Create: `packages/ui/src/components/bots/sidebar/BotSidebarSection.tsx`
- Create: `packages/ui/src/components/bots/sidebar/BotSidebarRow.tsx`
- Create: `packages/ui/src/components/bots/sidebar/BotSidebarSection.test.tsx`
- Create: `packages/ui/src/components/bots/chat/BotChatView.tsx`
- Create: `packages/ui/src/components/bots/chat/BotMessageList.tsx`
- Create: `packages/ui/src/components/bots/chat/BotMessageRow.tsx`
- Create: `packages/ui/src/components/bots/chat/BotComposer.tsx`
- Create: `packages/ui/src/components/bots/chat/BotRunStatus.tsx`
- Create: `packages/ui/src/components/bots/chat/BotChatView.test.tsx`
- Create: `packages/ui/src/components/bots/chat/BotComposer.test.tsx`
- Create: `packages/ui/src/components/bots/operations/BotOperationsRail.tsx`
- Create: `packages/ui/src/components/bots/operations/BotQueueTab.tsx`
- Create: `packages/ui/src/components/bots/operations/BotApprovalsTab.tsx`
- Create: `packages/ui/src/components/bots/operations/BotArtifactsTab.tsx`
- Create: `packages/ui/src/components/bots/operations/BotBrowserDiagnostic.tsx`
- Create: `packages/ui/src/components/bots/operations/BotOperationsRail.test.tsx`
- Create: `packages/ui/src/components/bots/operations/BotBrowserDiagnostic.test.tsx`
- Create: `packages/ui/src/components/bots/codemap.md`
- Create: `packages/ui/src/components/bots/DOCUMENTATION.md`
- Create: `packages/ui/src/components/views/BotView.tsx`
- Modify: `packages/ui/src/components/views/lazyViews.tsx`
- Modify: `packages/ui/src/components/session/SessionSidebar.tsx`
- Modify: `packages/ui/src/components/layout/MainLayout.tsx`
- Modify: `packages/ui/src/components/layout/RightSidebarTabs.tsx`
- Modify: `packages/ui/src/components/layout/Header.tsx`
- Modify: `packages/ui/src/lib/i18n/messages/en.ts`
- Modify: `packages/ui/codemap.md`
- Modify: `packages/ui/src/components/session/sidebar/codemap.md`
- Modify: `packages/ui/src/components/layout/codemap.md`
- Modify: `packages/ui/src/components/views/codemap.md`

- [ ] Add a focused Bots section above project sessions without adding Bot grouping logic to `SessionNodeItem.tsx` or the ordinary session store. Selecting a Bot opens/creates the owner channel and clears ordinary session selection; selecting a session clears Bot selection.
- [ ] Render encrypted canonical messages with the existing lazy `MarkdownRenderer`, but use Bot-owned message/run components rather than fabricating OpenCode sessions. Show seamless checkpoints/revision markers without exposing segment IDs.
- [ ] The composer waits for the server acceptance response before clearing. Docker-stopped shows `Docker Desktop isn’t running`, Setup/Repair actions when available, and keeps text/attachments intact.
- [ ] In Bot mode, hide repository Sources/Files/Git, project actions, ContextPanel, ordinary BrowserPanel, and terminal controls. Render Bot Operations tabs for Live Computer, Activity/Queue, Approvals, and Artifacts. On narrow screens use the existing right drawer.
- [ ] Add the diagnostic live screen and take/return controls. It must pause agent input, identify the human controller, expire stale control, and never imply frames are recorded.
- [ ] VS Code renders a deliberate `Bots require the DevRyan macOS app` state and never calls runtime setup APIs. Browser clients attached to the Electron server get full HTTP/SSE UI but no Docker setup mutation controls.
- [ ] Test keyboard/focus/ARIA, Reader vs Collaborator, queue position, approvals, Docker states, 220/280/500 px sidebar widths, dark/light themes, mobile drawer, and no repo controls in Bot mode.
- [ ] Commit `feat(bots): add private Bot chat and operations UI`.

#### Task 14: Add the structured Bot editor, membership, lifecycle, and Test Lab

**Files:**
- Create: `packages/ui/src/components/sections/bots/BotsPage.tsx`
- Create: `packages/ui/src/components/sections/bots/BotGallery.tsx`
- Create: `packages/ui/src/components/sections/bots/BotEditor.tsx`
- Create: `packages/ui/src/components/sections/bots/BotRevisionForm.tsx`
- Create: `packages/ui/src/components/sections/bots/BotMemberships.tsx`
- Create: `packages/ui/src/components/sections/bots/BotPolicyEditor.tsx`
- Create: `packages/ui/src/components/sections/bots/BotLifecycleActions.tsx`
- Create: `packages/ui/src/components/sections/bots/BotTestLab.tsx`
- Create: `packages/ui/src/components/sections/bots/BotsPage.test.tsx`
- Create: `packages/ui/src/components/sections/bots/BotRevisionForm.test.tsx`
- Create: `packages/ui/src/components/sections/bots/BotMemberships.test.tsx`
- Create: `packages/ui/src/components/sections/bots/BotPolicyEditor.test.tsx`
- Create: `packages/ui/src/components/sections/bots/BotLifecycleActions.test.tsx`
- Create: `packages/ui/src/components/sections/bots/BotTestLab.test.tsx`
- Modify: `packages/ui/src/components/views/SettingsView.tsx`
- Modify: `packages/ui/src/components/views/ManagedSettingsView.tsx`
- Modify: `packages/ui/src/components/views/lazyViews.tsx`
- Modify: `packages/ui/src/lib/i18n/messages/en.settings.ts`
- Modify: `packages/ui/src/components/sections/codemap.md`

- [ ] Build a structured revision editor for identity/title/avatar, standing role, objectives, tone, operating/prohibited instructions, Team/Personalized tenancy, primary/fallback models, reasoning, allowed file tools, browser policy, action policy, Library versions, memory policy, and advanced prompt.
- [ ] Only global admins create a Bot and initial Manager. Managers edit Draft revisions, membership, credentials metadata, policies, Library, routines, and lifecycle. Active revisions are read-only; editing creates the next Draft.
- [ ] Activation runs exact health gates: schema, Docker image digests, model catalogs/credential, egress hosts, tool manifest, policy coverage, Library/index status, and saved eval suite. Future chats/routines use the new active revision automatically; in-flight runs remain pinned.
- [ ] Implement Draft Test Lab with separate test computer/profile, forced simulated writes, saved eval cases, and a separately confirmed live canary. Simulation cannot call the real mutating browser command path.
- [ ] Implement Draft/Active/Pause/Retire and granular Purge dialogs. Purge previews channels, shared/private memory, objects, credentials, browser profiles, workspaces, indexes, audit retention, and irreversible consequences; require typed Bot name and Manager/global-admin policy.
- [ ] Test 409 revision conflicts, final Manager protection, assignment/revocation, simulation escape attempts, lifecycle send/routine gates, and purge preview/partial-failure recovery.
- [ ] Commit `feat(bots): add Bot management and test lab`.

### Phase 7: Memory, Library, routines, and recovery

#### Task 15: Add asynchronous layered memory and Manager-only governance

**Files:**
- Create: `packages/web/server/lib/bots/memory-runtime.js`
- Create: `packages/web/server/lib/bots/memory-classifier.js`
- Create: `packages/web/server/lib/bots/memory-consolidation.js`
- Create: `packages/web/server/lib/bots/indexer-client.js`
- Create: `packages/web/server/lib/bots/memory-runtime.test.js`
- Create: `packages/web/server/lib/bots/memory-classifier.test.js`
- Create: `packages/web/server/lib/bots/memory-consolidation.test.js`
- Create: `packages/web/server/lib/bots/indexer-client.test.js`
- Create: `packages/ui/src/components/sections/bots/BotMemoryConsole.tsx`
- Create: `packages/ui/src/components/sections/bots/BotMemoryEditor.tsx`
- Create: `packages/ui/src/components/sections/bots/BotMemoryConsole.test.tsx`
- Modify: `packages/web/server/lib/bots/runtime.js`
- Modify: `packages/web/server/lib/bots/routes.js`
- Modify: `packages/ui/src/components/sections/bots/BotEditor.tsx`

- [ ] After each completed run, enqueue a no-tools extraction session using the pinned revision model and a strict JSON schema. Do not delay the user-visible completion on extraction.
- [ ] Classify each candidate to `shared`, `user_private`, or `thread_only`; reject raw transcript quotes, secrets, unsupported scope, and invalid provenance. Commit immutable versions with sensitivity/confidence and update the local index.
- [ ] Run bounded consolidation/deduplication while DevRyan is open. Preserve conflicts as versions until deterministic policy/model resolution; never let a stale consolidation overwrite a newer Manager edit.
- [ ] Manager-only console supports inspect provenance, edit, merge, tombstone, restore, and rebuild. Ordinary Members cannot list memory rows, including their own private layer, matching the accepted decision.
- [ ] Channel deletion removes channel/private memory and index rows but deliberately retains shared memories. Confirmation and audit must state that shared learning survives.
- [ ] Test cross-user leakage prevention, automatic shared classification, confidential user-private classification, async failure without chat loss, version conflicts, Manager edits, source deletion behavior, and full rebuild.
- [ ] Commit `feat(bots): add layered automatic memory`.

#### Task 16: Add encrypted Library snapshots, private artifacts, and reviewed refresh

**Files:**
- Create: `packages/web/server/lib/bots/library-runtime.js`
- Create: `packages/web/server/lib/bots/source-scanner.js`
- Create: `packages/web/server/lib/bots/artifact-service.js`
- Create: `packages/web/server/lib/bots/library-runtime.test.js`
- Create: `packages/web/server/lib/bots/source-scanner.test.js`
- Create: `packages/web/server/lib/bots/artifact-service.test.js`
- Create: `packages/ui/src/components/sections/bots/BotLibrary.tsx`
- Create: `packages/ui/src/components/sections/bots/BotLibraryImport.tsx`
- Create: `packages/ui/src/components/sections/bots/BotLibraryDiff.tsx`
- Create: `packages/ui/src/components/sections/bots/BotLibrary.test.tsx`
- Modify: `packages/ui/src/components/bots/operations/BotArtifactsTab.tsx`
- Modify: `packages/web/server/lib/bots/routes.js`

- [ ] Scan only Manager-selected files/folders. Reject traversal, symlink escape, device/socket/FIFO files, `.git`, secrets, unsupported binaries, and configured exclusions. Record encrypted source provenance; never return host paths to non-Managers.
- [ ] Copy/encrypt immutable objects to Supabase Storage, extract bounded text, show diff/size/security findings, and require Manager publication. No watcher or automatic refresh exists.
- [ ] Snapshot exact published Library version IDs into each run. New runs use newest published versions; in-flight runs keep their snapshot.
- [ ] Keep channel uploads/generated artifacts private. Explicit publish creates a distinct Library object/version with actor/provenance; widening an existing private object ACL is forbidden.
- [ ] Materialize only authorized objects into the private channel workspace and remove temporary plaintext after run/timeout.
- [ ] Test scan escapes, secret findings, diff review, immutable versioning, private artifact ACL, explicit publication, run pinning, and rebuild of index records.
- [ ] Commit `feat(bots): add curated Library and private artifacts`.

#### Task 17: Add structured routines and app-bound scheduling

**Files:**
- Create: `packages/web/server/lib/bots/routine-runtime.js`
- Create: `packages/web/server/lib/bots/routine-drafter.js`
- Create: `packages/web/server/lib/bots/routine-runtime.test.js`
- Create: `packages/web/server/lib/bots/routine-drafter.test.js`
- Create: `packages/ui/src/components/sections/bots/BotRoutines.tsx`
- Create: `packages/ui/src/components/sections/bots/RoutineEditor.tsx`
- Create: `packages/ui/src/components/sections/bots/RoutineDraftReview.tsx`
- Create: `packages/ui/src/components/sections/bots/BotRoutines.test.tsx`
- Modify: `packages/web/server/lib/bots/runtime.js`
- Modify: `packages/web/server/lib/bots/routes.js`
- Modify: `packages/electron/quit-risk.mjs`

- [ ] Define the executable routine schema: trigger, timezone, goal, inputs, allowed tools/accounts/origins, limits, approval class, timeout, missed policy/cap, and completion criteria. Natural-language text is rationale only.
- [ ] Use a no-tools Bot run to draft this structure conversationally, then require Manager review and activation.
- [ ] Atomically claim occurrences before run creation. On startup compute missed occurrences and apply `skip`, `run_once`, or `replay_capped`; cap replay at three. External writes default to `run_once` and a fresh approval.
- [ ] Resolve the current active revision at occurrence claim time, honoring the accepted automatic rollout decision. Record the exact revision in the run and reevaluate all action policy/approvals.
- [ ] Pause/retire/revocation/runtime-offline blocks dispatch without losing due state. App quit checkpoints the scheduler; no timer/process claims background availability.
- [ ] Test DST/timezone, duplicate process claims, missed policies, app restart, paused/retired lifecycle, membership revocation, revision activation, queue fairness, and unknown-write reconciliation.
- [ ] Commit `feat(bots): add structured local routines`.

#### Task 18: Add disaster recovery, retention, and destructive cleanup

**Files:**
- Create: `packages/web/server/lib/bots/recovery-bundle.js`
- Create: `packages/web/server/lib/bots/purge-runtime.js`
- Create: `packages/web/server/lib/bots/recovery-bundle.test.js`
- Create: `packages/web/server/lib/bots/purge-runtime.test.js`
- Create: `packages/electron/bot-recovery-dialog.mjs`
- Create: `packages/electron/tests/bot-recovery-dialog.test.mjs`
- Create: `packages/ui/src/components/sections/bots/BotRecovery.tsx`
- Create: `packages/ui/src/components/sections/bots/BotRecovery.test.tsx`
- Modify: `packages/web/server/lib/bots/routes.js`
- Modify: `packages/electron/main.mjs`

- [ ] Build a versioned recovery manifest and passphrase encryption using Node `scrypt` + AES-256-GCM. Default export includes the deployment key, Bot/config manifest, and selected Library/workspace objects; connector vault and browser profile volumes require separate explicit high-risk checkboxes.
- [ ] Never stream unencrypted bundle material through renderer memory. Electron owns native save/open dialogs and atomic temp-file write/fsync/rename, matching diagnostics export ownership.
- [ ] Restore only into a verified compatible/empty deployment or an explicit merge flow with ID collision checks. Validate manifest hashes and image/schema versions before changing state.
- [ ] Implement resumable purge steps with per-resource results. Supabase rows, Storage objects, local vault entries, runtime containers, named volumes, index namespaces, and retained audit have separate dispositions; partial failure remains visible/retryable.
- [ ] Run one-year audit pruning only after delivery barriers and preserve retention-change/purge audit events.
- [ ] Test wrong passphrase, corrupt/truncated bundle, safe-vs-secret sections, restore collision, partial purge retry, shared-memory retention on channel delete, and full deletion on Bot purge.
- [ ] Commit `feat(bots): add recovery export and resumable purge`.

### Phase 8: Image release, documentation, and end-to-end acceptance

#### Task 19: Publish signed multi-architecture Bot images and enforce branded release artifacts

**Files:**
- Create: `scripts/build-bot-runtime-images.mjs`
- Create: `scripts/verify-bot-runtime-images.mjs`
- Create: `scripts/verify-bot-runtime-images.test.mjs`
- Modify: `.github/workflows/release.yml`
- Modify: `packages/electron/scripts/build-web-assets.mjs`
- Modify: `packages/electron/scripts/bundle-main.mjs`
- Modify: `packages/electron/package.json`
- Modify: `scripts/bump-version.mjs`
- Modify: `scripts/test-release-build.sh`
- Modify: `scripts/codemap.md`

- [ ] Build `linux/arm64` and `linux/amd64` images for `devryan-bot-supervisor`, `devryan-bot-egress`, `devryan-bot-indexer`, `devryan-bot-opencode`, and `devryan-bot-computer`. Generate SBOM/provenance and push lowercase GHCR tags plus immutable digests.
- [ ] Sign each digest keylessly with GitHub OIDC/cosign. Generate a versioned release manifest containing image name, platform digest, source revision, OpenCode version, schema version, plugin hash, and SBOM digest.
- [ ] Make Electron release builds download and bundle that manifest; development uses `images.dev.json`. Runtime pull/inspect must match the bundled digest before setup becomes healthy.
- [ ] Upload the public manifest as `DevRyan-bot-runtime-images-<version>.json`. Extend release verification to require `DevRyan` branding and reject public `OpenChamber-*`/`openchamber-*` Bot assets.
- [ ] Add all new package versions to release checks and full test gates.
- [ ] Run script tests and a dry-run image build/manifest verification; expect PASS.
- [ ] Commit `build(bots): publish signed runtime images`.

#### Task 20: Complete documentation, full validation, and the MVP runtime matrix

**Files:**
- Modify: `AGENTS.md` only if runtime ownership guidance changed during implementation
- Modify: `CODEMAP.md`
- Modify: package/module `codemap.md` and `DOCUMENTATION.md` files touched above
- Modify: `docs/TESTING.md`
- Create: `docs/BOTS_RUNTIME.md`
- Create: `docs/audits/2026-08-22-production-bots-mvp.md`

- [ ] Document trust boundaries, setup/repair/update, Docker-off behavior, app-bound availability, data locations, encryption/recovery, Team/Personalized scopes, broad computer LAN warning, policy/approval limits, browser-write uncertainty, retention, and support diagnostics.
- [ ] Run focused tests after every task, then the complete gates:

```bash
bun run validate:full
bun run build
bun run electron:build
bun run release:test:arm
bun run release:test:intel
git diff --check
```

Expected: all commands exit 0. If a platform build cannot run on the active Mac, record the exact unavailable command in the audit and require the corresponding release CI job before completion; do not mark it passed locally.
- [ ] Run the Supabase agent-test visual matrix using password-free loopback login for Test Administrator and Test Developer. Verify membership, private channel isolation, Reader/Collaborator ACLs, Manager-only memory, Docker setup states, and no hidden repository paths.
- [ ] Run the Docker runtime matrix on Apple Silicon and Intel: first setup, restart, image update/rollback, Docker stopped before send, Docker stopped during read, Docker stopped after unknown write, Team FIFO, Personalized parallel scopes, browser profile persistence/reset, take/return control, index rebuild, channel deletion, Bot purge, and recovery restore.
- [ ] Capture light/dark screenshots at 220/280/500 px sidebar widths and mobile drawer for empty/loading/error/queued/running/approval/reconciliation/paused/retired states. Store paths/results in the audit, not in this plan.
- [ ] Inspect the final diff for secret material, unbounded logs, broad store subscriptions, host-path exposure, Docker socket leakage, public legacy-branded assets, forbidden upstream references, and accidental Tauri/VS Code feature additions.
- [ ] Commit `docs(bots): document and verify the Docker MVP`.

## Non-negotiable acceptance checks

- Docker stopped before send creates no message/run and preserves composer input.
- Ordinary DevRyan coding sessions behave exactly as before and never use Bot containers.
- A Bot OpenCode container cannot reach the computer directly, another workspace, LAN, arbitrary internet hosts, Docker socket, host auth store, Git, shell, or arbitrary MCP.
- The broad-LAN choice applies only to the visible computer container and is disclosed to Managers.
- Team Bot channels share computer/account state but never transcript, private memory, attachment, or workspace state without explicit ACL/publication.
- Personalized Bot computer/profile/credential state cannot cross users.
- One and only one run owns a computer scope; queued order survives restart.
- An action cannot execute without a durable policy decision; changed args/revision invalidate approval.
- Unknown writes are never replayed automatically.
- All private chats teach, but classification prevents user-private/confidential facts from entering shared memory.
- Deleting a channel visibly retains shared learning; only Manager forget/purge removes it.
- Supabase contains ciphertext, metadata, and sanitized audit—not plaintext messages, object keys, connector secrets, browser cookies, or local host paths.
- Docker volume/index loss cannot destroy canonical history; Docker-off history remains readable.
- No screencast frame is retained by default.
- New active revisions affect every future chat/routine run, while in-flight runs remain pinned.
- Pause/retire never destroys history or runtime state; Purge is granular, resumable, and audited.
- Electron is the only runtime owner; VS Code never starts or mutates Docker resources.
- Public release assets and container product names use `DevRyan` branding.

## Implementation order and ship points

1. **Phases 1–3:** dark infrastructure only; no UI exposure.
2. **Phases 4–5:** API/runtime integration behind a disabled capability flag; exercise with server tests and admin-only diagnostic endpoints.
3. **Phase 6:** first interactive internal ship—Bot catalog, private chat, queue, policy approvals, browser diagnostic, Docker errors.
4. **Phase 7:** complete MVP product contract—memory, Library, routines, recovery, purge.
5. **Phase 8:** signed image/release gate and production acceptance.

Do not expose a partial Bot button before Phases 1–5 are green. Do not call Phase 6 production-ready until Phase 7’s privacy, retention, and recovery contracts are implemented.
