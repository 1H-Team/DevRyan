# DevRyan Testing

## Required gates

- `bun run test:full` is the deterministic repository test gate. It recursively discovers repository script tests, runs every test-owning workspace package, and includes the locked legacy Tauri Cargo suite.
- `bun run validate:quick` selects checks from the current changed-file set for fast local feedback.
- `bun run validate:affected` expands validation to affected packages and shared-runtime dependents.
- `bun run validate:full` runs workspace lint, type checks, and the full deterministic test gate.
- Release verification also runs `bun run build` and `bun run bundle:check`.

The full gate rejects skipped or todo tests, undiscovered JavaScript/TypeScript test files, test-owning workspace packages omitted from `test:full`, and stale paths in the checked feature matrix.

## Suite ownership

| Surface | Command or runner | Ownership |
| --- | --- | --- |
| Repository, release, and project-plugin tooling | `bun run test:scripts` | `scripts/**/*.test.mjs` and `.opencode/plugins/**/*.test.mjs`, recursively discovered by `scripts/test-scripts.mjs` |
| Harness runtime | `bun run --cwd packages/harness-runtime test` | Diagnostics journal, evidence, worktree, lifecycle, and process contracts |
| Managed orchestration | `bun run --cwd packages/orchestration-runtime test` | Shared managed-task admission, scheduling, cancellation, and recovery |
| Production Bots runtime | `bun run --cwd packages/bots-runtime test` | Strict JSON contracts, lifecycle/policy state, scope isolation, leases, action hashing, and routine recovery |
| Production Bot engine proxy | `bun run --cwd packages/bot-engine-proxy test` | Eleven Engine-operation schemas, API-version/path hardening, ownership labels, response bounds, and proof that the supervisor has no socket mount |
| Production Bot computer | `bun run --cwd packages/bot-computer test` | Authenticated reviewed Chromium commands, profile/scratch ownership, accessibility refs, control, screencast, and gateway file transfer |
| Production Bot retrieval index | `bun run --cwd packages/bot-indexer test` | Deterministic chunks, offline embeddings, SQLite FTS/vector ranking, namespace isolation, rebuild/recovery, and authenticated host API |
| Cursor SDK runtime | `bun run --cwd packages/cursor-sdk-runtime test` | Cursor execution, question bridge, tool calls, auth, and usage contracts |
| Electron | `bun run --cwd packages/electron test` | All Electron `*.test.*` files, recursively discovered outside generated/package output |
| Legacy Tauri | `bun run --cwd packages/desktop test` | Locked Rust unit and local integration tests in `src-tauri` |
| Shared UI | `bun run --cwd packages/ui test` | UI, store, sync, Git, tool presentation, and policy tests; global mocks run in isolated processes |
| Web | `bun run --cwd packages/web test` | Web runtime adapters, Express APIs, libraries, CLI, packaging, and integration contracts |
| VS Code | `bun run --cwd packages/vscode test` | Extension/webview Vitest suites plus recursively discovered package integration tests |

Runner, discovery, validation-selection, and release-gate changes belong to `scripts/`. Feature tests belong beside their source unless an integration contract spans packages.

## Checked feature matrix

`scripts/feature-test-matrix.mjs` is the executable source of truth connecting current source anchors to deterministic test anchors. Its contract test covers these feature families:

- shared UI, chat, session, and event synchronization;
- web/server APIs and web/VS Code `RuntimeAPIs` parity;
- Electron integrations and legacy Tauri compatibility;
- Cursor SDK, managed orchestration, and Production Bots runtime contracts;
- diagnostics, evidence, worktrees, providers, and quota;
- Git, GitHub, terminal, skills, plugins, MCP, notifications, and TTS;
- browser preview/CDP, CLI/tunnels/auth, packaging, release branding, validation, bundle budgets, and agent evaluations;
- product-tool discovery, permission aliases, provider prompt policy, presentation families, state/target rendering, activity grouping, unknown-tool fallback, and managed-task replacement cards.

Tool tests intentionally describe stable policy and presentation families instead of enumerating every possible plugin tool. A newly discovered tool must remain visible through the safe generic fallback.

## Fixture rules

Deterministic suites must use temporary directories, injected dependencies, or loopback-only fake services. Tests must not require credentials, live providers, external network access, the user's configuration, or installed-app state. Always clean up temporary files and child processes, including failure paths.

Use narrow fixtures that state the contract being exercised. Preserve public compatibility identifiers such as `@openchamber/*`, `OPENCHAMBER_*`, `openchamber://`, config paths, and event names. DevRyan branding assertions apply to public release filenames and user-facing release metadata.

Do not silence a deterministic scenario with `skip` or `todo`. Remove tests for deleted behavior, or rewrite them around the current contract. Nondeterministic/manual validation belongs in release or audit documentation, not the required unit/integration gate.

## Production Bots Docker and acceptance gates

The normal deterministic gate never requires Docker. Three opt-in groups use
only disposable test containers/volumes and must be run on a release host with a
healthy Docker Engine:

```bash
DEVRYAN_RUN_DOCKER_TESTS=1 bun test packages/bot-supervisor
DEVRYAN_RUN_BROWSER_TESTS=1 bun test packages/bot-computer/src/browser.test.js
DEVRYAN_RUN_BOT_INDEXER_DOCKER_TESTS=1 bun run --cwd packages/bot-indexer test
```

The supervisor group verifies the real Docker-socket round trip through the
engine proxy, owned-resource confinement, internal/public network split,
browser-egress failure closure, and standard/runsc replacement when the host
advertises gVisor. The engine-proxy deterministic suite covers all eleven
version-normalized operations plus malformed bodies, path/query smuggling,
upgrades, ownership, image/network/volume scope, and unavailable-proxy behavior.
The Chromium group builds the fixture image and verifies authenticated explicit
proxying, public/private/metadata/redirect/rebinding policy, token rotation,
login persistence, ref fencing, control contention, profile reset, private file
transfer, and graceful flush. The indexer group builds the pinned offline-model
image and verifies exact namespace isolation, persistence across container
replacement, and `rebuild_required` after deleting its disposable volume.

The Production Bots release acceptance gate is:

```bash
bun run validate:full
bun run build
bun run electron:build
bun run release:test:arm
bun run release:test:intel
git diff --check
```

`electron:build` is expected to reject a release build without the
release-generated, signature-verified `bot-runtime/images.release.json`. Do not
copy the development manifest into that location or record that safety failure
as a pass. Build and sign the multi-architecture images through the release
workflow, verify their SBOM/provenance/signatures, then rerun packaging.

The local Tauri compatibility smokes still build the app and DMG when release
signing secrets are unavailable, but omit updater artifacts and code signing in
that case. Supplying `TAURI_SIGNING_PRIVATE_KEY` retains the signed updater path;
the unsigned local smoke is compilation/packaging evidence, not release-signing
evidence.

Run the Docker matrix on both Apple Silicon and Intel macOS. An Apple Silicon
host is not evidence for an Intel Docker/packaging pass (or vice versa); when a
platform is unavailable locally, record the exact command as unavailable and
require the matching release-CI job. Include Docker-running and Docker-stopped
preflight behavior, setup/repair/update/rollback, Team and Personalized scopes,
browser uncertainty/reconciliation, index rebuild, launchd-owned routine recovery,
Skill materialization, local/remote MCP manifest drift and uncertain writes,
and recovery/purge partial-failure behavior. Never stop a user's active Docker
Engine merely to satisfy an audit; use an isolated host or record the live case
as unavailable and retain deterministic test evidence separately.

Live multi-user verification uses the password-free `agent_test` accounts from
`AGENTS.md`. Build the current UI/server first, then start an isolated data root
on a spare port when the user's app already owns the normal runtime. Confirm the
target Supabase deployment contains migration `20260830150000` before creating a
synthetic Bot. If the migration is missing, retain the `migration_required`
evidence, create no fixture, and mark membership/transcript/ACL/runtime cases
unavailable rather than bypassing the control plane.

The committed test-only fixture in `tests/visual-production-bots/` renders the
real Bot settings, policy, transcript, operations rail, dialogs, and narrow
stores without entering the production bundle. Its Electron-CDP capture is:

```bash
bun run visual:bots:capture -- --output .cache/e2e/production-bots-visual/reviewed
```

The release-candidate variant first packages the dedicated test shell with the
pinned Electron runtime and then drives that packaged application through CDP.
The shell is emitted only under ignored `.cache/e2e/`; neither the shell nor the
fixture enters the DevRyan application bundle:

```bash
bun run visual:bots:capture:packaged -- --output .cache/e2e/production-bots-visual/packaged
```

Visual acceptance covers light and dark themes, 1280×800 and 390×844
viewports, 220/280/500px rails, the mobile drawer, OpenCode/AG-UI connection
states, signed-spec trust/binding/diff failures, matcher/quota states,
browser-egress and runsc failures, runtime-service lifecycle, exact transcript
Activity/Approval focus, partial failures, paused/retired Bots, and
administrator/developer presentation. It also covers the persistent optimistic/
canonical acknowledgment before a final-only result and the decoded Computer
canvas in connecting, live, disconnected, owned, view-only, and conflicting
control states. Durable control-wait scenes cover owner Return Control and
another-operator presentation. Generated-image scenes cover loading, decoded
ready, and error/retry states independently of Shared publication. These are
deterministic component fixtures, not evidence of a live OAuth generation.
The capture blocks on clipping/overflow,
stale scroll origin, focused-row visibility, keyboard Tab/Enter/Escape, focus
rings, unnamed dialogs, secret sentinels, console errors, and unhandled
rejections. Browser-network scenes also block unless the real network/isolation
fieldset is inside the screenshot viewport. It always writes screenshots and JSON evidence; cross-machine pixel
baselines are not blocking.

Store only sanitized, reviewed evidence under a dated `docs/audits/` directory.
The 2026-08-27 matrix and assertions are documented in
`docs/audits/2026-08-27-agent-agnostic-bots/README.md`. See
`docs/BOTS_RUNTIME.md` for the operational and security boundaries that the
matrix must preserve.

The macOS Bot Catalog click must also pass the native hit-test smoke:

```bash
bun run electron:test:native-pointer -- --output docs/audits/<date>-bot-settings/native-pointer
```

This command builds the current Electron web assets, launches a separate
temporary DevRyan/Chromium profile, uses the password-free Test Administrator,
and posts a real CoreGraphics mouse click at the enabled Catalog `+` bounds. It
passes only when the `Create Bot` dialog appears and writes a PNG, bounded
Electron log, and safe JSON evidence. It deliberately fails on non-macOS hosts,
missing agent-test configuration, or missing Accessibility event-posting access;
do not turn those prerequisites into a skipped unit test. Hosted CI requires a
managed interactive macOS runner before this command can become a release gate.

After `bun run electron:build`, the release-candidate pairing uses the packaged
DevRyan application for that same isolated, loopback-only native test:

```bash
bun run electron:test:native-pointer:packaged -- --output .cache/e2e/bot-catalog-native-pointer/packaged
```

`bun run visual:bots:acceptance` runs the packaged fixture matrix followed by
the packaged native-pointer smoke. It intentionally fails when the signed app,
agent-test configuration, interactive session, or Accessibility permission is
missing; release operators must record that prerequisite failure rather than
silently replacing the native test with a synthetic click.

Database migration verification is local-only: run an isolated Supabase stack,
apply `supabase db reset`, assert forced RLS and browser-role revocations for
`bot_skill_packages`/`bot_mcp_bindings`, then run `supabase db lint --local`.
Never use `--linked` or target the production database for this check.
