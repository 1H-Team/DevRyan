# Production Bots Docker MVP verification

- Audit plan date: 2026-08-22
- Local execution date: 2026-08-23 (Africa/Casablanca)
- Implementation range: `cfebe9b7..80b83e6d` (312 committed files before this
  documentation commit)
- Local host: macOS 26.6.2, Apple Silicon (`arm64`)
- Docker client/server: 29.5.2, Linux Engine `arm64`

## Decision

**Production acceptance is not complete.** The implementation and the available
Apple Silicon Docker fixtures passed, but the configured Supabase deployment is
missing required Production Bots migration `20260823100000`. Consequently no
synthetic Bot could be created and the live membership/channel/ACL/memory/run
matrix could not execute. Intel, signed packaged-image, full lifecycle, and live
Docker-stopped cases also require release infrastructure that was not available
on this host. These cases are recorded as unavailable, never as passes.

The runtime must not be enabled for production until the release blockers in
[Required follow-up](#required-follow-up) are closed with a new dated audit or
an addendum containing the exact CI/run evidence.

## Scope and method

The review covers the Production Bots implementation commits from runtime
contracts through signed image publication, plus the create-Draft error
visibility and Bot JSON request-parser fixes discovered during this audit. It
does not authorize or review the legacy Tauri implementation or the VS Code
runtime as Bot owners; neither received Bot feature files in the commit range.

Evidence used four distinct levels:

1. deterministic source/package tests;
2. real disposable Docker fixtures on this Apple Silicon host;
3. a live isolated DevRyan web runtime using the configured Supabase and the
   password-free `agent_test` identities;
4. a temporary ignored Vite harness that rendered the real Bot components and
   stores with deterministic states for visual coverage only.

The visual harness proves presentation and responsive-state coverage; it does
not substitute for Supabase, policy, encryption, or Docker acceptance.

## Full validation and release gates

| Command | Local result | Evidence / disposition |
| --- | --- | --- |
| `bun run validate:full` | **PASS on complete rerun** | First run: lint and all type checks passed; script, runtime, Electron, legacy Tauri, and UI packages passed. Web finished 2,433/2,434 with one missing-final-event timing failure in `server/lib/opencode/cursor-sdk-runtime.test.js`; the exact file immediately passed 59/59 in 1.86s. A complete rerun passed all packages. After the audit-discovered parser repair, the final complete rerun also passed: UI 3,019/3,019, web 2,438/2,438, VS Code 234/234 plus 21/21 quota-parity tests, exit 0. |
| `bun run build` | **PASS** | All workspaces exited 0. Existing Vite chunking, ONNX `eval`, CJS `import.meta` warnings remained non-fatal. |
| `bun run electron:build` | **UNAVAILABLE — exit 1 at required safety gate** | Packaging stopped before mutation with `bot_runtime_release_source_invalid`: `packages/electron/resources/bot-runtime/images.release.json` is absent. Release CI must generate and verify the signed manifest; no development manifest was substituted. |
| `bun run release:test:arm` | **UNAVAILABLE — exit 1 at signing** | Image-plan/signing contract passed 9/9; UI, aarch64 sidecar, native app, DMG, and updater archive built. The command then required unavailable protected `TAURI_SIGNING_PRIVATE_KEY`. |
| `bun run release:test:intel` | **UNAVAILABLE — exit 1 at signing** | Image-plan/signing contract passed 9/9; x86_64 target, sidecar, native app, DMG, and updater archive cross-built on arm64. The command then required unavailable protected `TAURI_SIGNING_PRIVATE_KEY`; this is not Intel-host Docker evidence. |
| `git diff --check` | **PASS** | Final documentation/evidence diff contains no whitespace errors. |

Task-level and final-gate stabilization reruns isolated three ambient timing
flakes: the agent-evaluation cleanup deadline, preview liveness coalescing, and
the Cursor synthesized-patch final-event observation above. Each exact owning
suite passed immediately when rerun. No production code was weakened to hide
those timing failures.

## Apple Silicon Docker evidence

All tests below used disposable resources and the real Docker Engine:

| Command | Result | What it exercised |
| --- | --- | --- |
| `DEVRYAN_RUN_DOCKER_TESTS=1 bun test packages/bot-supervisor` | PASS — 24/24 | Docker-socket client round trip, owned resource naming/labels, fixed verbs, confinement, replacement, and scoped reset. |
| `DEVRYAN_RUN_BROWSER_TESTS=1 bun test packages/bot-computer/src/browser.test.js` | PASS — 7/7 | Chromium login persistence, generation-fenced refs, human-control arbitration, private upload/download, profile reset, and graceful profile flush. |
| `DEVRYAN_RUN_BOT_INDEXER_DOCKER_TESTS=1 bun run --cwd packages/bot-indexer test` | PASS — 22/22 | Pinned offline model/image, exact namespaces, restart persistence, and `rebuild_required` after volume loss. |

The user's installed DevRyan app was already running against their normal data
directory. This audit did not stop the host Docker Engine because that would
disrupt active user work. Docker-stopped behavior was therefore evaluated only
by deterministic Electron/server tests; the live Engine-off rows below remain
unavailable.

## Supabase agent-test matrix

The current UI and web server were built with:

```bash
bun run build:ui && bun run build:web
```

An isolated server was started on `127.0.0.1:3101` with a temporary
`OPENCHAMBER_DATA_DIR` containing only a mode-`0600` copy of the existing
Supabase configuration. No password was read, typed, stored, or transmitted.
The app's loopback-only agent-test login minted ordinary audited sessions.

| Check | Result | Evidence |
| --- | --- | --- |
| Test Administrator password-free login | PASS | Settings exposed Bots and User Management; Bot catalog exposed Create Draft. |
| Test Developer password-free login | PASS | Settings omitted Bots and User Management; sidebar projected `No Bots assigned`. |
| Agent-test fixtures hidden from human User Management | PASS by server contract / UI observation | The dedicated identities did not require or expose passwords and are excluded from the human management surface. |
| Required Bot schema | **FAIL / deployment blocker** | A read-only `public.bots` schema probe returned HTTP 404 / PostgREST `PGRST205` (`public.bots` absent from schema cache). The server maps this to `bot_schema_migration_required`, required migration `20260823100000`. |
| Bot JSON request delivery | PASS after audit repair | The first live Create Draft attempt exposed that the common request middleware omitted all four Bot API namespaces, so `req.body` was undefined and the server returned `bot_request_invalid`. Commit `80b83e6d` adds the exact Bot namespaces plus regression coverage; a live retry reached the schema boundary. |
| Synthetic Bot creation | UNAVAILABLE | No fixture was created because the authoritative schema is absent. The create dialog now surfaces `Database migration required` and stable code `bot_schema_migration_required` instead of hiding the request failure. |
| Membership and Team/Personalized assignment | UNAVAILABLE | Requires a created Bot. |
| Private channel isolation | UNAVAILABLE | Requires Bot/channel fixtures. |
| Reader cannot send / Collaborator can send | UNAVAILABLE | Requires Bot/channel ACL fixtures. |
| Manager-only memory and Library host-path projection | UNAVAILABLE | Requires Bot fixtures and encrypted records. Static route tests enforce Manager-first authorization. |
| Docker capability/setup states through live Bot UI | UNAVAILABLE | Schema readiness fails before runtime readiness can become authoritative. |
| Hidden repository-path check in Bot data | UNAVAILABLE | No Bot response or Library source could be created. Committed screenshots contain no host path. The general managed-session UI may retain its assigned real path under the current multi-user contract, so this audit makes no broader path-opacity claim. |

This is an external deployment-state failure, not a locally repairable fixture
failure. Bypassing the schema probe, creating local plaintext records, or
manually manufacturing rows would invalidate the acceptance test.

## Runtime matrix

`PASS (deterministic)` means repository tests cover the state machine or adapter
without claiming that the live Supabase/Docker scenario ran. `UNAVAILABLE`
requires the follow-up shown in the last column.

| Scenario | Apple Silicon result | Intel result | Required follow-up / evidence boundary |
| --- | --- | --- | --- |
| First setup | UNAVAILABLE | UNAVAILABLE | Requires published signed multi-architecture images and packaged release manifest; run on both release Macs. |
| Runtime restart / persistent volumes | PASS (Docker fixtures) | UNAVAILABLE | Browser/index fixtures passed on arm64; repeat Docker fixtures on x64. |
| Image update and rollback | PASS (deterministic manager tests) | UNAVAILABLE | Exercise staged signed images in packaged apps on arm64 and x64. |
| Docker stopped before send | PASS (deterministic) | UNAVAILABLE | Live isolated Engine-off test must prove no message/run and preserved composer on both platforms. |
| Docker stopped during read | PASS (deterministic) | UNAVAILABLE | Live matrix must confirm failed read and explicit new retry. |
| Docker stopped after unknown write | PASS (deterministic) | UNAVAILABLE | Live matrix must confirm `needs_reconciliation` and no replay. |
| Team FIFO | PASS (deterministic) | UNAVAILABLE | Atomic scope claim/queue tests pass; live Supabase queue requires migration. |
| Personalized parallel scopes | PASS (deterministic) | UNAVAILABLE | Scope isolation tests pass; live parallel execution requires migration. |
| Browser profile persistence/reset | PASS (Docker fixture) | UNAVAILABLE | Repeat real Chromium fixture on x64. |
| Human take/return control | PASS (Docker fixture) | UNAVAILABLE | Repeat real Chromium fixture on x64 and live UI after migration. |
| Index rebuild after volume loss | PASS (Docker fixture) | UNAVAILABLE | Repeat pinned image fixture on x64. |
| Channel deletion with shared-learning tombstone | PASS (deterministic) | UNAVAILABLE | Live Supabase/storage/index matrix requires migration. |
| Granular/resumable Bot purge | PASS (deterministic) | UNAVAILABLE | Live Docker/storage partial-failure run requires migration and signed images. |
| Recovery export/restore | PASS (deterministic) | UNAVAILABLE | Live `.drbr` round trip, optional secret sections, and Docker profile restore require migration and signed images. |
| App-bound missed routine recovery | PASS (deterministic) | UNAVAILABLE | Live quit/restart run requires migration; no daemon availability may be claimed. |

## Visual evidence

The first five captures use actual Bot UI components/stores in the deterministic
visual harness. The final three are live isolated Supabase-role views. Each image
was inspected before inclusion; no password, token, host path, private message,
or unrelated session title is present.

| Artifact | Size | Covered states |
| --- | --- | --- |
| [`visual-states-light.png`](2026-08-22-production-bots-mvp/visual-states-light.png) | 1440×1000 | Light theme; exact 220/280/500px sidebar fixtures; active, paused, retired, empty, loading, error, queued, running, approval, reconciliation. |
| [`visual-states-dark.png`](2026-08-22-production-bots-mvp/visual-states-dark.png) | 1440×1000 | Dark-theme parity for the same widths and lifecycle/run states. |
| [`mobile-drawer-light.png`](2026-08-22-production-bots-mvp/mobile-drawer-light.png) | 390×844 | Actual mobile Bot operations drawer and Live Computer disclosure. |
| [`mobile-drawer-dark-activity.png`](2026-08-22-production-bots-mvp/mobile-drawer-dark-activity.png) | 390×844 | Dark mobile Activity state. |
| [`mobile-drawer-dark-approvals.png`](2026-08-22-production-bots-mvp/mobile-drawer-dark-approvals.png) | 390×844 | Dark mobile approval and unknown-write reconciliation actions. |
| [`supabase-admin-empty.png`](2026-08-22-production-bots-mvp/supabase-admin-empty.png) | 1178×720 | Live Test Administrator: Bots/User Management access and empty catalog. |
| [`supabase-admin-migration-required.png`](2026-08-22-production-bots-mvp/supabase-admin-migration-required.png) | 1178×720 | Live Test Administrator: Create Draft request reaches the fail-closed missing-migration boundary and visibly reports the stable error code. |
| [`supabase-developer-role-gating.png`](2026-08-22-production-bots-mvp/supabase-developer-role-gating.png) | 1178×720 | Live Test Developer: settings omit Bots and User Management. |

## Final security diff audit

The committed implementation range was inspected directly, not only through
tests.

| Review item | Result |
| --- | --- |
| Secret material | PASS. No committed credential values, sealed keys, Supabase configuration, recovery bundle, auth stage, cookies, or bearer values were found. Sensitive environment names are fixed inputs; tests assert plaintext is absent from vaults, logs, labels, and public payloads. |
| Logs | PASS with bounded identifier note. Service logs contain startup/error codes; computer control logs actor type/ID for attribution. Gateway/store tests prove tokens, payloads, values, and ciphertext do not enter logs. |
| Zustand subscriptions | PASS. No zero-selector `useBotsStore()`, `useBotChannelStore()`, or `useBotOperationsStore()` call exists in Bot UI/store code. Hot data uses leaf projections and isolated components. |
| Host paths | PASS for Bot authorization boundary. Library host path/provenance is encrypted at rest and returned only after Manager authorization; ordinary Bot projections omit it. No host path appears in committed visual evidence. Live verification remains blocked by the missing schema. |
| Docker socket | PASS with accepted threat. Only `bot-supervisor` mounts `/var/run/docker.sock`; Compose, manager GID discovery, and supervisor adapter are the only production references. The runbook discloses root-equivalent risk. |
| Public release branding | PASS. Public release staging/verifiers require `DevRyan-*` assets and reject legacy prefixes. Compatibility identifiers remain unchanged; a legacy-prefixed string exists only as a negative verifier fixture. |
| Forbidden upstream repositories | PASS. No upstream OpenChamber repository was read or referenced, and no forbidden repository path appears in the implementation range. |
| Public/private projection | PASS (deterministic), live unavailable. Route/event tests reject hidden payload fields and unauthorized identifiers; Manager/ACL live verification requires the migration. |

## Non-negotiable acceptance disposition

The source and deterministic suites enforce the requested invariants: preflight
before atomic send, no ordinary-session Bot path, reasoning/container
confinement, computer-only broad LAN, channel/private scope separation,
single-scope leases, exact action approvals, no unknown-write replay, layered
memory classification, shared-learning tombstones, ciphertext/object-key
envelopes, rebuildable index, ephemeral screencast, pinned revisions,
non-destructive pause/retire, resumable purge, Electron-only ownership, and
DevRyan public asset branding.

They are not all live-accepted. The following conditions prevent a production
ship decision from being recorded here.

## Required follow-up

1. Deploy and verify both Production Bots migrations, especially
   `20260823100000`, in the configured Supabase project. Refresh the PostgREST
   schema cache if the deployment process requires it.
2. Rerun the complete password-free Administrator/Developer matrix with a
   synthetic Bot, Team and Personalized memberships, owner/Reader/Collaborator
   channels, Manager memory/Library checks, encrypted objects, capability
   states, and explicit absence of Bot host paths from non-Manager projections.
3. Publish the signed multi-architecture Bot images and generated release
   manifest through the release workflow; verify digests, SBOM, provenance,
   keyless signatures, and architecture completeness before packaging.
4. Run packaged first-setup, repair, staged update, rollback, recovery, purge,
   Docker-stopped, and unknown-write cases on isolated Apple Silicon and Intel
   Macs. Attach the exact CI job/run and artifact names.
5. Rerun every command in the full-gate table. All expected commands must exit
   zero before production completion; an unavailable platform must remain a
   required release-CI job, not a local pass.

Until those items are complete, the correct availability result is
`migration_required`, `setup_required`, or another explicit non-healthy state,
and Bot execution must remain fail-closed.
