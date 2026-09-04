# Repository Atlas: DevRyan

## Project Responsibility

DevRyan is a Bun/Node monorepo that provides web, desktop, and VS Code UI runtimes for interacting with an OpenCode server. The shared React UI lives in `packages/ui`; `packages/web` owns the Express server, browser bootstrap, CLI, and the optional Supabase-backed shared-host control plane; `packages/shared-runtime` owns dependency-light configuration-apply, quota-normalization, assistant-image syntax, and safe-archive rules shared by web/Electron and VS Code; `packages/bots-runtime` owns dependency-free Production Bots JSON contracts plus the scoped OpenCode image/plugin; `packages/bot-supervisor` owns the fixed-verb Docker lifecycle boundary without socket access; `packages/bot-engine-proxy` is the sole Docker-socket process; `packages/bot-egress` owns purpose-separated model, AG-UI endpoint, and browser network policy; `packages/bot-computer` owns the persistent reviewed-command Chromium service; `packages/bot-indexer` owns the disposable Docker-local FTS/vector retrieval projection; `packages/cursor-sdk-runtime` owns shared Cursor SDK execution/auth helpers; `packages/harness-runtime` owns durable harness operations, diagnostics, lifecycle, evidence, and cross-process persistence primitives; `packages/electron` is the primary desktop shell and optional launchd runtime-service executable; `packages/desktop` is the legacy Tauri shell; `packages/vscode` hosts the same experience inside VS Code.

## System Entry Points

- `package.json`: workspace manifest and top-level build/validation/dev commands.
- `packages/web/server/index.js`: Express/OpenCode server bootstrap and runtime composition root.
- `packages/web/bin/cli.js`: `openchamber` CLI entrypoint for serving, auth, tunnels, and operator workflows.
- `packages/web/src/main.tsx`: standalone web bootstrap that injects runtime APIs before loading shared UI.
- `packages/shared-runtime/index.js`: cross-host safe-archive, configuration-apply coordinator, quota-adapter, assistant-image parser, free-Zen rotation, and PR-output normalization exports.
- `packages/bots-runtime/index.js`: Production Bots enums, strict JSON boundaries, lifecycle/policy transitions, scope derivation, action hashing, lease admission, and routine recovery.
- `packages/cursor-sdk-runtime/index.js`: shared Cursor SDK model execution, virtual provider discovery, split SDK/usage credential helpers, and the public pending-question contract.
- `packages/cursor-sdk-runtime/cursor-question-runtime.js`: authenticated loopback MCP question bridge for primary Cursor Builder/Orchestrator runs.
- `packages/ui/src/main.tsx`: shared React UI mount and provider initialization.
- `packages/electron/main.mjs`: primary desktop main process; boots or connects to the local web runtime and supports a windowless `--runtime-service` owner mode.
- `packages/electron/preload.mjs`: Electron renderer bridge and `__TAURI__` compatibility shim.
- `docker/bots/compose.yml`: fixed Electron-owned Production Bots service topology with persistent named volumes.
- `docs/BOTS_RUNTIME.md`: Production Bots availability, trust boundaries, Docker operations, data/recovery, policy, retention, and diagnostics runbook.
- `packages/desktop/src-tauri/src/main.rs`: legacy Tauri command host and sidecar launcher.
- `packages/vscode/src/extension.ts`: VS Code extension activation and provider registration.
- `packages/vscode/webview/main.tsx`: VS Code webview bootstrap for shared UI.
- `scripts/validate.mjs`: changed-file-aware validation planner used by quick/affected/full checks.
- `scripts/test-scripts.mjs` and `scripts/test-suite-contract.test.mjs`: recursive repository-test runner and full-gate completeness contract.
- `scripts/feature-test-matrix.mjs`: checked source-to-test anchors for the supported feature and tool families.
- `scripts/check-bundle-budgets.mjs`: deterministic Vite-manifest startup graph and bundle-budget verifier for web and VS Code builds.

## Repository Directory Map

| Directory | Responsibility Summary | Detailed Map |
|-----------|------------------------|--------------|
| `packages/` | Workspace package boundary for runtime packages and shared UI/server layers. | [packages/codemap.md](packages/codemap.md) |
| `packages/ui/` | Shared React UI runtime, feature components, Zustand stores, and event-sync pipeline used by all shells. | [packages/ui/codemap.md](packages/ui/codemap.md) |
| `packages/web/` | Browser app, Express/OpenCode server runtime, and `openchamber` CLI. | [packages/web/codemap.md](packages/web/codemap.md) |
| `packages/shared-runtime/` | Dependency-light safe-archive, configuration-apply, and provider-quota contracts shared by web/Electron and VS Code. | [packages/shared-runtime/codemap.md](packages/shared-runtime/codemap.md) |
| `packages/bots-runtime/` | Dependency-free Production Bots JSON contracts, lifecycle/policy state machines, scope keys, action hashing, lease admission, and missed-run recovery. | [packages/bots-runtime/codemap.md](packages/bots-runtime/codemap.md) |
| `packages/bot-supervisor/` | Fixed-verb, authenticated Docker lifecycle and confinement boundary for Production Bots containers. | [packages/bot-supervisor/codemap.md](packages/bot-supervisor/codemap.md) |
| `packages/bot-engine-proxy/` | Sole-socket, eleven-operation Docker Engine proxy with independent ownership/image/network/volume validation. | [packages/bot-engine-proxy/codemap.md](packages/bot-engine-proxy/codemap.md) |
| `packages/bot-egress/` | Purpose-separated model, registered-agent, and browser HTTP/CONNECT egress with exact-host/public-address policy. | [packages/bot-egress/codemap.md](packages/bot-egress/codemap.md) |
| `packages/bot-computer/` | Persistent scoped Chromium profile, reviewed accessibility commands, human-control lease, ephemeral screencast, and private file staging. | [packages/bot-computer/codemap.md](packages/bot-computer/codemap.md) |
| `packages/bot-indexer/` | Disposable local SQLite FTS/vector projection with exact shared/private/channel namespaces and offline pinned embeddings. | [packages/bot-indexer/codemap.md](packages/bot-indexer/codemap.md) |
| `packages/cursor-sdk-runtime/` | Shared Cursor SDK execution runtime used by web/Electron and VS Code; quota credentials remain deliberately separate in each surface's quota module. | [packages/cursor-sdk-runtime/codemap.md](packages/cursor-sdk-runtime/codemap.md) |
| `packages/orchestration-runtime/` | Dependency-free DevRyan-managed task contract, dispatch-barrier, and scheduler policy shared by web/Electron and VS Code owners. | [packages/orchestration-runtime/codemap.md](packages/orchestration-runtime/codemap.md) |
| `packages/harness-runtime/` | Durable harness operations, diagnostic journal, lifecycle correlation, and optional turn evidence shared by host runtimes. | [packages/harness-runtime/codemap.md](packages/harness-runtime/codemap.md) |
| `packages/electron/` | Primary desktop shell plus fenced launchd runtime-service mode, native OS integrations, and renderer/broker bridges. | [packages/electron/codemap.md](packages/electron/codemap.md) |
| `packages/desktop/` | Legacy Tauri desktop shell retained for existing-install migration compatibility. | [packages/desktop/codemap.md](packages/desktop/codemap.md) |
| `packages/vscode/` | VS Code extension host, bridge router, OpenCode manager, and webview runtime. | [packages/vscode/codemap.md](packages/vscode/codemap.md) |
| `packages/vscode/webview/` | VS Code-specific webview adapter that exposes bridge-backed runtime APIs to shared UI. | [packages/vscode/webview/codemap.md](packages/vscode/webview/codemap.md) |
| `docker/` | Production Bots image/compose deployment definitions owned by the Electron runtime manager. | [docker/codemap.md](docker/codemap.md) |
| `scripts/` | Repository automation for validation, dev orchestration, release/build smoke checks, and utility tasks. | [scripts/codemap.md](scripts/codemap.md) |
| `tests/visual-production-bots/` | Test-only real-component visual fixture and separately packaged Electron CDP shell for Production Bots state coverage. | [tests/visual-production-bots/codemap.md](tests/visual-production-bots/codemap.md) |

## Where To Change Things

- **Session change summaries, capture, revision review and card Undo/Redo** → `packages/harness-runtime/lib/session-changes*.js`, `packages/web/server/default-config/plugins/devryan-session-changes.mjs`, and `packages/ui/src/components/chat/sessionChangesController.ts`. Contract and limits: `docs/SESSION_CHANGES.md`; real-component fixture: `tests/visual-session-changes/`.

- **Session creation latency/cancellation** → `packages/ui/src/sync/session-creation.ts`, `session-actions.ts`, `session-ui-store.ts`, `packages/web/server/lib/opencode/session-creation.js`, and `context-mode-native-hotfix.js`. Isolated benchmarks: `scripts/benchmark-session-creation.mjs`; real-worker checks: `scripts/verify-context-mode-workers.mjs`; packaged-renderer fixture: `tests/visual-session-creation/codemap.md`; results: `docs/SESSION_CREATION_VERIFICATION.md`.

- **Shared host/Bot OpenAI OAuth, stale login copies or reconnect errors** → `docs/BOT_OAUTH_COORDINATION.md`, `packages/web/server/lib/opencode/openai-oauth-coordinator.js`, `packages/web/server/lib/bots/host-oauth-connections.js`, and `packages/web/server/default-config/plugins/devryan-openai-oauth.mjs`.

- **Primary provider stall/recovery policy** → `packages/harness-runtime/lib/provider-recovery*.js`, web harness and VS Code host adapters; see `docs/PROVIDER_RECOVERY.md`. Shared UI: `HostPrimaryRecovery.tsx`; isolated fixtures: `tests/visual-provider-recovery/` and `tests/provider-recovery/`.

- **Shared UI, views, stores, hooks, theme, chat, settings** → start in `packages/ui/codemap.md`, then the relevant `packages/ui/src/**/codemap.md`.
- **Session history click latency, adaptive message pages, intent prefetch, or first-visible metrics** → `packages/ui/src/sync/codemap.md`, `packages/ui/src/sync/session-message-loader.ts`, `packages/ui/src/sync/session-load-performance.ts`, and `packages/ui/src/components/session/sidebar/hooks/useSessionPrefetch.ts`.
- **Server routes, OpenCode integration, terminal/git/GitHub/quota/TTS/skills/session-plan APIs** → start in `packages/web/codemap.md`, then `packages/web/server/codemap.md` and `packages/web/server/lib/codemap.md`.
- **Cross-host ZIP installation safety, batched configuration apply state, provider quota normalization, or assistant-image syntax parity** → `packages/shared-runtime/codemap.md` and `packages/shared-runtime/DOCUMENTATION.md`; host adapters remain in web and VS Code.
- **Cloudflare tunnel lifecycle, stable origin relay, public reachability, link exchange, and Remote Tunnel settings UI** → `packages/web/server/lib/tunnels/DOCUMENTATION.md`, `packages/web/server/lib/opencode/DOCUMENTATION.md`, and `packages/ui/src/components/sections/openchamber/TunnelSettings.tsx`.
- **Shared-host identity, Supabase roles/policies, managed project and branch grants, session ownership, directory opacity, live revocation, or actor audit** → `packages/web/server/lib/multi-user/codemap.md` and `packages/web/server/lib/multi-user/DOCUMENTATION.md`; the administration UI starts in `packages/ui/src/components/sections/users/codemap.md`.
- **Managed bug intake or administrator diagnostic review** → `packages/ui/src/components/sections/bug-reports/codemap.md` for the page and `packages/web/server/lib/multi-user/{bug-reports.js,activity-projection.js,error-diagnostics.js,diagnostic-recovery.js}` plus the module documentation for storage, access, impact, recovery, and sanitization.
- **Web browser bootstrap or web runtime API adapters** → `packages/web/src/codemap.md` and `packages/web/src/api/codemap.md`.
- **CLI commands, prompts, output modes, tunnel/auth operator flows** → `packages/web/bin/codemap.md`.
- **Electron desktop behavior, IPC, menus, dialogs, notifications, updater, deep links** → `packages/electron/codemap.md`.
- **Detachable manual/agent browser surfaces, session-scoped leases, managed browser CLI/skill, or private browser tool** → `packages/electron/codemap.md`, `packages/ui/src/components/layout/codemap.md`, `packages/ui/src/stores/codemap.md`, `packages/web/src/codemap.md`, `packages/web/server/lib/browser-cdp/codemap.md`, `packages/web/server/lib/agent-browser/codemap.md`, and `packages/web/server/default-config/codemap.md`.
- **Browser tabs, viewport presets/resizing, project-preview grants, loopback host routing, console/element inspection, or detachable web pop-outs** → `packages/ui/src/components/layout/codemap.md`, `packages/electron/codemap.md`, `packages/ui/src/apps/codemap.md`, `packages/web/src/codemap.md`, and `packages/web/server/lib/preview/codemap.md`.
- **Legacy Tauri compatibility only** → `packages/desktop/codemap.md`; do not add new desktop features there unless explicitly required for released Tauri users.
- **VS Code extension host or webview bridge behavior** → `packages/vscode/codemap.md`, `packages/vscode/src/codemap.md`, and `packages/vscode/webview/codemap.md`.
- **DevRyan-managed task identity, admission, dispatch barriers, cancellation, recovery, or persistence policy** → `packages/orchestration-runtime/codemap.md` and `packages/orchestration-runtime/DOCUMENTATION.md`.
- **Production Bots enums, strict boundary shapes, lifecycle/policy state, scope keys, exact action hashing, lease admission, or missed-run recovery** → `packages/bots-runtime/codemap.md` and `packages/bots-runtime/DOCUMENTATION.md`.
- **Production Bots Docker manifests, setup/update/rollback, or fixed service topology** → `packages/electron/codemap.md` and `docker/codemap.md`.
- **Production Bots dynamic Docker lifecycle, engine-proxy ownership, Bot-wide Shared volume/import, or governed model/agent/browser egress policy** → `packages/bot-supervisor/codemap.md`, `packages/bot-supervisor/DOCUMENTATION.md`, `packages/bot-engine-proxy/codemap.md`, `packages/bot-egress/codemap.md`, and `packages/bot-egress/DOCUMENTATION.md`.
- **Production Bots scoped OpenCode tool surface or persistent computer/browser runtime** → `packages/bots-runtime/codemap.md`, `packages/bots-runtime/DOCUMENTATION.md`, `packages/bot-computer/codemap.md`, and `packages/bot-computer/DOCUMENTATION.md`.
- **Production Bots local retrieval, index namespaces, offline embeddings, or rebuild/corruption behavior** → `packages/bot-indexer/codemap.md` and `packages/bot-indexer/DOCUMENTATION.md`.
- **Production Bots multi-architecture images, SBOM/provenance digests, keyless signing, or branded release manifests** → `scripts/build-bot-runtime-images.mjs`, `scripts/verify-bot-runtime-images.mjs`, `scripts/codemap.md`, `.github/workflows/release.yml`, and `packages/electron/bot-runtime-manifest.mjs`.
- **Hosted database migration deployment without a release** → `.github/workflows/supabase-migrate.yml`; pending migrations live in `supabase/migrations/`, and the release workflow independently verifies migration history and the required Bot schema marker before publication.
- **Production Bots settings/resources, native Telegram/speech, inline shared computer, optional Skills, memory, confirmations, channels/dispatch, channel-runtime ownership, terminal audit settlement, background scheduling, lifecycle, compatibility persistence, or resumable purge** → start with `docs/BOTS_SIMPLIFICATION_2026-08-27.md` and the operator/security runbook at `docs/BOTS_RUNTIME.md`, then `packages/web/server/lib/bots/codemap.md`, `packages/web/server/lib/bots/DOCUMENTATION.md`, `packages/ui/src/components/bots/codemap.md`, `packages/ui/src/components/bots/DOCUMENTATION.md`, `packages/ui/src/components/sections/codemap.md`, and `packages/electron/codemap.md`. Upgrade verification is recorded in `docs/BOT_UPGRADE_VERIFICATION_2026-08-31.md`.
- **Atomic private persistence/cross-process locks, durable worktree receipts, diagnostics, lifecycle correlation, or turn evidence primitives** → `packages/harness-runtime/codemap.md` and `packages/harness-runtime/DOCUMENTATION.md`.
- **Secure assistant-response images and path-bound grants** → `packages/web/server/lib/image-assets/codemap.md`, `packages/web/server/lib/image-assets/DOCUMENTATION.md`, and `packages/ui/src/components/chat/message/parts/codemap.md`.
- **Web/Electron managed scheduler ownership, private tool/barrier bridge, ledger, OpenCode transport, or UI routes** → `packages/web/server/lib/orchestration/codemap.md` and `packages/web/server/lib/orchestration/DOCUMENTATION.md`.
- **VS Code managed scheduler ownership, private tool bridge, ledger, OpenCode/Cursor transport, or webview routes** → `packages/vscode/src/codemap.md`, `packages/vscode/src/DOCUMENTATION.md`, and `packages/vscode/webview/api/codemap.md`.
- **Shared managed-task cards, snapshot/event projection, recovery controls, or primary-agent handoff UI** → `packages/ui/src/stores/codemap.md`, `packages/ui/src/stores/DOCUMENTATION.md`, `packages/ui/src/sync/DOCUMENTATION.md`, and `packages/ui/src/components/chat/codemap.md`.
- **Validation/build/dev scripts** → `scripts/codemap.md` and the specific script file.
- **Test ownership, discovery, feature coverage, or Production Bots visual acceptance** → `docs/TESTING.md`, `scripts/feature-test-matrix.mjs`, `scripts/test-suite-contract.test.mjs`, and `tests/visual-production-bots/codemap.md`.
- **Generated/bundled asset folders** → treat their codemaps as ownership pointers; change source packages instead of editing generated output.

## Cross-Runtime Flow

1. A host runtime starts or connects to OpenCode: web CLI/server, Electron main process, legacy Tauri sidecar, or VS Code extension host.
2. The host exposes runtime APIs over HTTP, WebSocket/SSE, IPC, or VS Code webview messaging.
3. Shared UI initializes providers and stores, consumes runtime APIs, and renders session/chat/settings/tooling surfaces.
4. On a Supabase-configured shared web host, the server resolves an opaque app session into one principal, confines non-admin paths to granted project roots and their shared OpenCode worktree containers, and filters HTTP/SSE/WS traffic by session ownership before feature handlers or OpenCode receive it.
5. Live OpenCode events flow through server/extension bridges into UI sync stores; managed-host events are ownership-filtered and projected into the content-free actor audit feed.
6. In Electron, every Browser-capable authenticated account uses a main-owned `WebContentsView` over the workstation's network. Manual browsing is authorized against the renderer's DevRyan session and stored in a persistent partition isolated by DevRyan host plus principal; browser-using tool turns retain their separate fenced lease surfaces and CDP identity.
7. In standalone web, Browser tabs route only approved loopback project apps through session-bound host proxy targets. Other HTTP(S) destinations open in the viewer's regular browser, so public, LAN, VPN, and intranet traffic never egresses through the DevRyan server. Detachable surfaces exchange versioned state on the same DevRyan origin.
8. Packaging scripts build the shared UI/server outputs into Electron, legacy Tauri, VS Code, or standalone web deployments.

## Integration Notes

- The web server is the feature backend for web and Electron; native shells should stay thin and capability-focused.
- Electron is the forward desktop path. Tauri remains present for auto-update migration and compatibility.
- Shared UI is runtime-agnostic by contract; branch on capability APIs rather than shell identity wherever possible.
- High-frequency session/message state is handled through the UI sync pipeline rather than broad Zustand store fanout.
- Keep this root atlas and the nearest subdirectory `codemap.md` updated when moving entrypoints, package ownership, or cross-runtime contracts.

## Operational Evidence

- [ECC performance and agent-evaluation pass](docs/audits/2026-07-15-ecc-performance-and-agent-eval-pass.md): sanitized startup-graph measurements, live provider/evaluation coverage, Electron UI evidence, explicit unavailable checks, and final verification for the context-efficiency and agent-evaluation workstream.
- [Production Bots Docker MVP verification](docs/audits/2026-08-22-production-bots-mvp.md): trust-boundary audit, Apple Silicon Docker evidence, multi-user/visual matrix, cross-platform limitations, and final release-gate results.
- [Agent-agnostic Production Bots visual audit](docs/audits/2026-08-27-agent-agnostic-bots/README.md): 38 reviewed Electron-CDP states covering adapters, Bot-as-code, structured policy, egress/isolation, background runtime, exact Activity focus, narrow layouts, and restricted-role presentation.
- [Bot failure repair verification](docs/audits/2026-08-30-bot-failure-repair/README.md): memory conflict recovery, durable browser-control waiting, dedicated OAuth image tooling, local migration/Docker/visual evidence, and the hosted-schema prerequisite for remaining live acceptance.
