# DevRyan - AI Agent Reference (verified)

## Core purpose

DevRyan provides UI runtimes (web/desktop/VS Code) for interacting with an OpenCode server (local auto-start or remote URL). UI uses HTTP + SSE via `@opencode-ai/sdk`.

## Repository authority

- Canonical repository: `1H-Team/DevRyan`.
- Local workspace root: `/Users/zoubair/Repositories/DevRyan`.
- DevRyan is a separate repository for agent work, not a fork. Treat this repository and its local files as the only source of truth unless the user explicitly says otherwise in the current task.
- Do not read, browse, clone, diff, compare against, patch, or edit `openchamber/openchamber`, `btriapitsyn/openchamber`, `../openchamber`, or any other upstream OpenChamber checkout without explicit user permission in the current task.
- Existing local names such as `@openchamber/web`, `openchamber`, `OPENCHAMBER_*`, and config paths are implementation compatibility names. They are not permission to consult upstream OpenChamber.
- `OpenCode` is the external runtime dependency and remains valid context; do not confuse it with the forbidden upstream OpenChamber repository.

## Release branding (MANDATORY)

- All brand-bearing public GitHub Release asset filenames must use `DevRyan`. Distributable workflow artifacts exposed for direct download must also use `DevRyan`; internal handoff artifacts and tool-mandated neutral metadata such as `latest-mac.yml` may retain their required functional names. Never publish a user-facing asset with an `OpenChamber` or `openchamber` filename prefix.
- Keep compatibility identifiers unchanged unless the user explicitly requests and approves a migration. This includes `@openchamber/*` npm packages, the `openchamber` CLI, `OPENCHAMBER_*` environment variables, `openchamber://`, config paths, IPC/event names, and VS Code extension IDs.
- When a build tool derives an output filename from a compatibility identifier, copy it to a deterministic `DevRyan-*` staging filename before uploading it to GitHub Releases. Marketplace and npm publication may continue using the compatibility package identity.
- Release verification must require the branded filenames and reject legacy-prefixed public assets.

## Runtime architecture (IMPORTANT)

- `Desktop` (Electron) boots the web server **in the same Node process** as the Electron main, then loads the web UI from `http://127.0.0.1:<port>`. No sidecar subprocess.
- `Desktop` (Tauri, legacy) still spawns `openchamber-server` as a bun-compiled sidecar binary. Kept only for auto-update compatibility with existing Tauri installs.
- All backend logic lives in `packages/web/server/*` (and `packages/vscode/*` for the VS Code runtime). The native shell is not a feature backend.
- The shell is used only for stable native integrations: menu, dialog (open folder), notifications, updater, deep-links, quit confirmation.

### Desktop shell: Electron is the target, Tauri is legacy

- **New desktop work goes into `packages/electron/`.** This is the forward path.
- `packages/desktop/` (Tauri) is kept running in parallel only to preserve auto-update for existing installs until the cutover. Do **not** add features to it; do **not** port bug fixes back unless they actually affect currently-released Tauri users.
- Desktop-side changes (IPC handlers, native integrations, window/quit/notification behavior) land in `packages/electron/main.mjs` + `packages/electron/preload.mjs`. The `__TAURI__` shim exposed by the preload keeps the shared UI working against both shells, so renderer-side code should not branch on shell type.
- Electron imports the server via `@openchamber/web/server/index.js` (workspace dep) and calls `startWebUiServer({...})`. The returned handle has `getPort()` / `stop()`. Notifications flow via an `onDesktopNotification` callback injected at startup — no stdout-parsing IPC.
- Build/release: both shells ship in the same GitHub release today (`.github/workflows/release.yml`). The one-shot Tauri → Electron auto-update migration is documented in `docs/TAURI_TO_ELECTRON_CUTOVER.md`; run that when the user decides to flip.
- After the cutover ships and stabilises, `packages/desktop/` is deleted; this note collapses back to "Desktop is Electron".

## Tech stack (source of truth: `package.json`, resolved: `bun.lock`)

- Runtime/tooling: Bun (`package.json` `packageManager`), Node >=20 (`package.json` `engines`)
- UI: React, TypeScript, Vite, Tailwind v4
- State: Zustand (`packages/ui/src/stores/`)
- UI primitives: Base UI (`@base-ui/react`, primary source for dropdown/select/dialog/menu/tooltip/etc. — wrappers live in `packages/ui/src/components/ui/`), Radix UI (`package.json` deps, legacy usages being migrated), HeroUI (`package.json` deps), Remixicon (`package.json` deps)
- Server: Express (`packages/web/server/index.js`)
- Desktop (forward): Electron 41 (`packages/electron/`)
- Desktop (legacy, maintenance-only): Tauri v2 (`packages/desktop/src-tauri/`)
- VS Code: extension + webview (`packages/vscode/`)

## Monorepo layout

Workspaces are `packages/*` (see `package.json`).

- Shared UI: `packages/ui`
- Web app + server + CLI: `packages/web`
- Desktop shell (Electron — forward): `packages/electron`
- Desktop shell (Tauri — legacy, maintenance-only): `packages/desktop`
- VS Code extension: `packages/vscode`

## Repository Map

A full codemap is available at `CODEMAP.md` in the project root.

Before working on any task, read `CODEMAP.md` to understand:
- Project architecture and entry points
- Directory responsibilities and design patterns
- Data flow and integration points between modules

For deep work on a specific folder, also read that folder's `codemap.md`.

## Codemap-first navigation

- Before broad file searches, read `codemap.md` and use it to identify the likely package, module, and entrypoint.
- Prefer the codemap's "Where To Change Things" section for first-pass routing, then inspect the specific files it names.
- Use code search only after checking the codemap, or when the codemap does not identify the needed symbol, route, component, or module.
- If the repository structure changes, update `codemap.md` in the same change so future agents can find files through it.

## Documentation map

Before changing any mapped module, read its module documentation first.

### web

Web runtime and server implementation for DevRyan.

#### lib

Server-side integration modules used by API routes and runtime services.

##### quota

Quota provider registry, dispatch, and provider integrations for usage endpoints.

- Module docs: `packages/web/server/lib/quota/DOCUMENTATION.md`

##### git

Git repository operations for the web server runtime.

- Module docs: `packages/web/server/lib/git/DOCUMENTATION.md`

##### github

GitHub authentication, OAuth device flow, Octokit client factory, and repository URL parsing.

- Module docs: `packages/web/server/lib/github/DOCUMENTATION.md`

##### opencode

OpenCode server integration utilities including config management, provider authentication, and UI authentication.

- Module docs: `packages/web/server/lib/opencode/DOCUMENTATION.md`

##### notifications

Notification message preparation utilities for system notifications, including text truncation and optional summarization.

- Module docs: `packages/web/server/lib/notifications/DOCUMENTATION.md`

##### terminal

WebSocket protocol utilities for terminal input handling including message normalization, control frame parsing, and rate limiting.

- Module docs: `packages/web/server/lib/terminal/DOCUMENTATION.md`

##### tts

Server-side text-to-speech services and summarization helpers for `/api/tts/*` endpoints.

- Module docs: `packages/web/server/lib/tts/DOCUMENTATION.md`

##### skills-catalog

Skills catalog management including discovery, installation, and configuration of agent skill packages.

- Module docs: `packages/web/server/lib/skills-catalog/DOCUMENTATION.md`

##### diagnostics

Diagnostics HTTP contract for the journal: status, clear, export ZIP, and support-text sanitization endpoints.

- Module docs: `packages/web/server/lib/diagnostics/DOCUMENTATION.md`

### harness-runtime

Shared diagnostic journal runtime: NDJSON journal writer, mandatory sanitizer, export pipeline, storage layout and retention limits.

- Module docs: `packages/harness-runtime/DOCUMENTATION.md`

## Build / dev commands (verified)

All scripts are in `package.json`.

- Validate: `bun run type-check`, `bun run lint`
- Build all: `bun run build`
- Desktop build (Electron — primary): `bun run electron:build`
- Desktop dev (Electron): `bun run electron:dev`
- Desktop build (Tauri — legacy): `bun run desktop:build`
- VS Code build: `bun run vscode:build`
- Release smoke build: `bun run release:test` (shell script: `scripts/test-release-build.sh`)

## Runtime entry points

- Web bootstrap: `packages/web/src/main.tsx`
- Web server: `packages/web/server/index.js`
- Web CLI: `packages/web/bin/cli.js` (package bin: `packages/web/package.json`)
- Desktop (Electron — primary): `packages/electron/main.mjs` (boots the web server in-process via `startWebUiServer`, loads web UI over loopback; preload at `packages/electron/preload.mjs` exposes the `__TAURI__` IPC shim so shared UI code is shell-agnostic)
- Desktop (Tauri — legacy): `packages/desktop/src-tauri/src/main.rs`
- VS Code extension host: `packages/vscode/src/extension.ts`
- VS Code webview bootstrap: `packages/vscode/webview/main.tsx`

## OpenCode integration

- UI client wrapper: `packages/ui/src/lib/opencode/client.ts` (imports `@opencode-ai/sdk/v2`)
- Live event sync: `packages/ui/src/sync/event-pipeline.ts` and `packages/ui/src/sync/sync-context.tsx` (SyncProvider + SyncBridge; replaces removed `useEventStream` hook)
- Web server embeds/starts OpenCode server: `packages/web/server/index.js` (`createOpencodeServer`)
- Web runtime filesystem endpoints: search `packages/web/server/index.js` for `/api/fs/`
- External server support: Set `OPENCODE_HOST` (full base URL, e.g. `http://hostname:4096`) or `OPENCODE_PORT`, plus `OPENCODE_SKIP_START=true`, to connect to existing OpenCode instance

## Key UI patterns (reference files)

- Settings shell: `packages/ui/src/components/views/SettingsView.tsx`
- Settings shared primitives: `packages/ui/src/components/sections/shared/`
- Settings sections: `packages/ui/src/components/sections/` (incl `skills/`)
- Chat UI: `packages/ui/src/components/chat/` and `packages/ui/src/components/chat/message/`
- Theme + typography: `packages/ui/src/lib/theme/`, `packages/ui/src/lib/typography.ts`
- Terminal UI: `packages/ui/src/components/terminal/` (uses `ghostty-web`)

## External / system integrations (active)

- Git: `packages/ui/src/lib/gitApi.ts`, `packages/web/server/index.js` (`simple-git`)
- Terminal PTY: `packages/web/server/index.js` (`bun-pty`/`node-pty`)
- Skills catalog: `packages/web/server/lib/skills-catalog/`, UI: `packages/ui/src/components/sections/skills/`

## Agent constraints

- Work only inside `/Users/zoubair/Repositories/DevRyan` unless the user explicitly authorizes another path in the current task.
- Do not read or modify `../opencode` (separate repo) unless the user explicitly authorizes it in the current task.
- Do not read, browse, clone, diff, compare against, patch, or edit upstream OpenChamber repositories or checkouts (`openchamber/openchamber`, `btriapitsyn/openchamber`, `../openchamber`, or equivalents) unless the user explicitly authorizes it in the current task.
- Keep baseline green (run `bun run type-check`, `bun run lint` before finalizing changes).

## Agent code of conduct

- Prefer the smallest correct change.
- Preserve working behavior before improving structure.
- Do not add cleverness where a direct implementation is enough.
- Do not infer critical state from weak signals when a stronger source exists.
- Do not encode policy only in UI; enforce it in core logic.
- Do not hide data loss, partial failure, or fallback behavior. Make it explicit in code.
- Finish work end-to-end: implementation, verification, and cleanup.

## Development rules

- Keep diffs tight; avoid drive-by refactors.
- Follow local precedent; inspect nearby code before introducing new patterns.
- Backend changes: keep web, desktop, and VS Code behavior consistent when they share contracts.
- TypeScript: avoid `any`, blind casts, and shape guessing.
- React: prefer function components + hooks; use classes only when required.
- Control flow: prefer early returns and explicit branching over nested ternaries.
- Styling: Tailwind v4, typography via `packages/ui/src/lib/typography.ts`, theme vars via `packages/ui/src/lib/theme/`.
- Shared UI patterns: reuse shared primitives before introducing feature-local markup patterns.
- Toasts: use the wrapper from `@/components/ui`; do not import `sonner` directly in feature code.
- No new deps unless asked.
- Never add secrets or log sensitive data.

## Architecture patterns

### Thin entrypoints, focused modules

- Keep orchestration entrypoints thin: `index.js`, bridge files, bootstrap files, provider roots.
- Move route, domain, and runtime logic into focused modules with clear ownership.
- Prefer dependency injection over hidden module coupling.
- Add or update module documentation when ownership changes.

### Strong source of truth

- Prefer deterministic state over heuristics.
- Use live server/session state for live activity. Do not let historical anomalies masquerade as current execution.
- If a fallback is necessary, scope it narrowly to the active entity and treat it as temporary.
- Restore derived UI state from authoritative records. Example: restore model or agent from the latest user message, not assistant-side guesses.

### Live state vs historical state

- Derive live UI behavior from live state channels, not persisted history.
- Use historical records to restore context, not to infer that work is still in progress.
- If live state is delayed, use the narrowest possible transient fallback and clear it as soon as authoritative state arrives.

### Cross-runtime parity

- If web defines a route or payload contract that shared UI depends on, keep VS Code and desktop parity where applicable.
- Shared behavior differences must be intentional and visible in code.
- Do not ship a web-only assumption into shared UI.

### Partial-failure-safe flows

- Cross-directory and multi-entity operations must tolerate partial failure.
- Prefer per-item results, rollback paths, or resumable cleanup over all-or-nothing assumptions.
- Never leave optimistic state or local caches stranded after failure.

## CLI Parity and Safety Policy (MANDATORY)

### Principle: policy-first, UX-second

All safety and correctness rules MUST be enforced in core command logic, independent of output mode.

Interactive/pretty UX (`@clack/prompts`) is a presentation layer only.
It must never be the only place where validation or restriction is enforced.

### Required parity across modes

The same functional outcome and safety gates MUST hold for all execution modes:

- Interactive TTY (full Clack UX)
- Non-interactive shells (piped/stdin-less automation)
- `--quiet`
- `--json`
- Fully pre-specified flags (no prompts)

In all modes, invalid operations MUST fail with non-zero exit code and deterministic error semantics.

### Non-negotiable rule

Do not rely on prompts to enforce policy.

- Prompts MAY help users choose valid inputs.
- Core validators MUST run even when prompts are unavailable or skipped.
- `--quiet` suppresses non-essential output only; it does not weaken validation.
- `--json` changes output shape only; it does not weaken validation.

Detailed Clack UX patterns (primitives, prompt gating, and implementation checklist)
are defined in the `clack-cli-patterns` skill and should not be duplicated here.

## Clack CLI Skill (MANDATORY for terminal CLI work)

When working on terminal CLI commands, prompts, or output formatting, agents **MUST** study the Clack CLI skill first.

**Before starting terminal CLI work:**

```
skill({ name: "clack-cli-patterns" })
```

Scope: terminal CLI only (for example `packages/web/bin/*`). Do not apply this requirement to VS Code or web UI work.

## Performance rules (MANDATORY)

These rules exist because violating them has caused measurable regressions (render cascades, memory bloat, UI jank). They apply to all UI and sync layer work.

### Shared-store render discipline

- **Treat common stores as render fanout boundaries.** An unnecessary reference change in shared state can re-render large parts of the app.
- **Do not put high-frequency state in broadly consumed stores.** Fast-changing state should live in narrow stores with narrow subscribers.
- **Update only the fields that changed.** Preserve references for untouched state branches.
- **Prefer leaf selectors over container selectors.** Subscribe to the smallest stable value that satisfies the component.
- **Isolate hot consumers.** If a value changes often and only a few components need it, move it to a narrower store or consume it in a memoized child.
- **Do not subscribe shell/layout components to broad live collections.** If a shell only needs one field, entity, or derived flag, subscribe to that instead of the whole collection.
- **Treat provider roots as global hot paths.** A top-level provider must not subscribe to high-frequency data unless the feature is actually enabled and the subscription is essential.

### Zustand referential equality

Zustand skips re-renders when a selector returns the same reference (`Object.is`). Every new object/array reference triggers a re-render in every subscriber.

- **Never spread all state fields in an update.** Only create new references for fields that actually changed. A `message.part.delta` event should not clone `session`, `permission`, etc.
- **Select leaf values, not containers.** `useStore((s) => s.permission[sessionID])` is correct. `useStore((s) => s.permission)` subscribes to every permission change across all sessions.
- **Preserve references when merging.** If prepending older messages, keep existing message object references. Only add truly new items. Return the original array if nothing was added.
- **For derived collections, preserve item identity when presentation-relevant fields are unchanged.** Reuse previous item references for unchanged rows/items and move high-frequency live fields to narrow per-item selectors.

### Store splitting

A single store with N properties means every subscriber re-evaluates on every state change. Split stores by change frequency and subscriber set.

- **Group state by how often it changes.** Streaming state (updated 60/sec) must not live with user preferences (updated on click).
- **Group state by who reads it.** If only 2 components need a value, it belongs in a store that only those 2 subscribe to.
- **Cross-store reads use `.getState()`.** Actions in one store that need another store call `useOtherStore.getState()` — imperative, no subscription.
- **Never add unrelated state to an existing store** just because it's convenient. Create a new store.

### Event pipeline and SSE

- **Gate expensive operations on the hot path.** During streaming, `message.part.delta` and `message.part.updated` fire ~60/sec. Any `findIndex`, `filter`, or iteration added to these handlers multiplies across every event. Gate behind a cheap boolean check first (e.g., check `next[0]` before scanning the array).
- **Skip no-op updates.** If an incoming event doesn't change the state (same role, same finish, same timestamps), return `false` from the reducer to avoid creating new references.
- **Coalesce by key.** Same-entity events (e.g., repeated `session.status` for the same session) should replace earlier ones in the queue, not accumulate.
- **Preserve event ordering semantics.** Reducers and queues must not let stale deltas or out-of-order events corrupt the latest state.
- **Do not widen live-activity fallbacks.** A fallback for delayed status should inspect only the current trailing entity, not arbitrary historical records.

### Polling payload fidelity

- **Do not let lightweight polling erase rich fields.** If light mode omits fields (e.g., `diffStats`), preserve previous rich data until a heavy follow-up fetch lands.
- **Use two-phase polling.** Run cheap change detection first; only run heavy status fetches for directories that actually changed.

### Optimistic updates

- **Use the shadow Map pattern.** Insert optimistic data into the store for instant UI, AND register it in a separate tracking Map. Cleanup happens deterministically via `mergeOptimisticPage` on the next data fetch — not via heuristics in the event reducer.
- **Pass client-generated IDs to the server.** Use the same ID format as the server (hex-encoded timestamps). Pass `messageID` to `promptAsync` so the server echoes back the same ID. This prevents duplicates and enables in-place replacement.
- **Rollback on error.** Remove the optimistic entry from both the store and the shadow Map.
- **Stabilize bridge callbacks.** When wiring hook callbacks into module-level refs, use stable ref wrappers so effects do not loop on changing function identities.

### Session/input consistency

- **Capture send config at queue time.** Queue items must include provider/model/agent/variant snapshot; do not re-resolve from mutable live state at send time.
- **Keep server-selected attachments sendable.** Preserve server-backed file selections in queue/submit flows and convert them to proper `file://` URLs before sending.
- **Do not let text input state repaint unrelated chrome.** Typing should not force unrelated controls, menus, indicators, or toolbars to re-render on every keystroke.
- **Extract slow-changing chrome from hot input paths.** If controls do not depend on the current text value, move them behind memoized boundaries with stable callbacks.

### Bootstrap resilience

- **Treat startup 502/503 as transient.** Retry bootstrap/session-list flows with bounded retries/intervals, especially in VS Code where API readiness can lag bridge startup.
- **Use polling recovery when failures are swallowed.** If an async loader resolves without throwing on failure, recover with interval retries gated by loaded-state checks.

### Scroll and DOM

- **Never use `await waitForFrames()` for scroll preservation.** Frames of visible scroll jump are unacceptable. Use `useLayoutEffect` to adjust scroll synchronously after React commits DOM — before the browser paints.
- **Capture scroll state before the state change, restore in layout effect.** The pattern: save `scrollHeight`/`scrollTop` into a ref before triggering the update, consume it in `useLayoutEffect` on the rendered output.
- **Do not let viewport resizes masquerade as content growth.** Viewport-height changes must not trigger the same scroll compensation logic used for actual content growth.
- **Disable or narrow native/browser scroll anchoring when custom scroll logic exists.** Browser anchoring and app-managed pinning/follow logic will fight and produce jiggle.
- **Autosize textareas without transient collapse on growth.** Avoid `height='auto'` shrink/expand cycles on every character when the content only grew; this creates visible layout bounce.

### List ordering and view consistency

- **Do not sort structural lists directly from high-churn live fields.** If live updates are frequent, sorting directly from them causes reorder thrash and wide rerender cascades.
- **If live recency is required, freeze order during high-frequency updates and apply a one-shot reorder only at an intentional lifecycle edge.** Choose the lifecycle edge explicitly instead of letting every intermediate update reshuffle the UI.
- **Use one ordering source for all views of the same data.** Different views of the same entities must derive from the same ranked list or rank map; do not let each surface re-derive ordering independently.
- **Do not mix global snapshots and local live snapshots without an explicit reconciliation policy.** If multiple data sources feed one view, define which fields win and how they merge.

### Component isolation

- **Extract high-frequency hook consumers into separate components.** If a hook re-evaluates 60/sec (e.g., streaming status), wrap its consumer in a `React.memo` child component so the parent doesn't re-render.
- **Use custom `React.memo` comparators for message rows.** Compare render-relevant fields (role, finish, parts count, part IDs) — not object references.

### Caching and memory

- **Cap in-memory caches with both count and byte limits.** Entry count alone doesn't prevent memory bloat from large files. Use dual-constraint LRU (e.g., 40 entries OR 20MB).
- **Set store session limits to match loaded data.** If bootstrap loads N sessions, set `limit >= N`. Otherwise the next SSE event triggers trimming that silently removes sessions.
- **Invalidate caches on mutations.** File content cache must clear entries on write, delete, rename. Prefetch cache must clear on session eviction.
- **Use TTLs to prevent redundant fetches.** If a session was fetched <15s ago, skip re-fetching — SSE events keep it current.

### Directory context

- **Never cache directory strings in closures.** Directory can change at any time (worktree switch). Read it dynamically from `opencodeClient.getDirectory()` at call time.
- **Pass directory hints when the source of truth isn't available yet.** Newly created sessions aren't in the sync store until SSE delivers them. Pass the known directory as a parameter instead of relying on lookup.

## Multi-user visual verification (agent-test accounts)

The Supabase multi-user control plane reserves two fixture accounts exclusively
for AI agents doing visual verification. They are `account_kind = 'agent_test'`
in `user_profiles`, are deliberately hidden from the Users settings page and
`GET /api/admin/users`, and pass through the exact same authentication, policy,
assignment, ownership, and audit enforcement as human accounts:

- **Test Administrator** — `admin@1health.ae` (role `admin`; verifies admin
  flows: host-path pass-through, project registration, user management).
- **Test Developer** — `developer@1health.ae` (role `developer`; verifies the
  restricted experience: path aliasing, out-of-scope 403s, hidden settings).

**Agents must never type, store, or transmit passwords.** Instead use the
loopback-only, password-free login endpoint (`handleAgentTestSession` in
`packages/web/server/lib/multi-user/runtime.js`, mounted at
`POST /auth/agent-test-session` in `server/lib/opencode/core-routes.js`). It
only accepts active `agent_test` profiles, only from 127.0.0.1, and mints a
normal 12-hour app session (audited as `auth.agent_test_login`). From the
app's own browser tab:

```js
await fetch('/auth/agent-test-session', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-DevRyan-CSRF': '1' },
  body: JSON.stringify({ email: 'developer@1health.ae' }),
});
location.reload();
```

Calling it again with the other email switches roles; `POST /auth/logout`
(with the CSRF header) ends the session.

**Verification server recipe.** Only one DevRyan runtime may own managed
OpenCode orchestration per data directory. If the user's own app is running,
do not fight it — start a second server against an isolated data directory
(copy `supabase.json` into it so multi-user mode is enabled) on a spare port:

```bash
mkdir -p ~/.config/openchamber-verify
cp ~/.config/openchamber/supabase.json ~/.config/openchamber-verify/
OPENCHAMBER_DATA_DIR=~/.config/openchamber-verify bun packages/web/server/index.js --port 3101
```

Build first (`bun run build:ui && bun run build:web`) so the served UI matches
the working tree. Prefer the in-app browser preview tooling over raw shells
for the server so logs stay inspectable.

## Diagnostic journal (check it before theorizing)

Whenever the user reports a DevRyan runtime issue — stuck or hung sessions, missing or duplicated events, failed/rejected prompts, aborts that did not take effect, streaming or sync anomalies, worktree or evidence lifecycle issues — inspect the journal before forming a code-only theory. Start from the repository root:

```bash
bun scripts/journal.mjs list
bun scripts/journal.mjs show <sessionID> --tail 200
bun scripts/journal.mjs gaps
```

When the report starts with an Error Log event UUID, treat that UUID as a durable administrative locator, not as the detailed execution record:

1. Resolve the UUID through the administrator Error Log detail surface/API first. Capture the `sessionId`, timestamp, action/kind, and every available `callId`, `toolId`, `messageId`, or `taskId`.
2. Use the session plus the strongest correlation identifier to inspect the corresponding local journal, for example `bun scripts/journal.mjs show <sessionID> --grep <callId>`. Fall back to `toolId`, `messageId`, `taskId`, or a bounded `--since`/`--until` timestamp window when no call ID exists.
3. Run `bun scripts/journal.mjs gaps` before drawing conclusions.
4. Do not expect the Error Log UUID itself to appear in journal records. Error Logs and the journal are separate stores correlated through session and tool/message/task identifiers: Error Logs provide durable administrative indexing, classification, and bounded sanitized summaries; the journal is the source for prompts, tool output, lifecycle ordering, recovery behavior, and detailed failure evidence.
5. If the relevant host journal is unavailable, expired, or contains a qualifying gap, report that limitation instead of reconstructing missing detail.

- Location (web/Electron): `~/.config/openchamber/harness/journal/` (data-root override: `$OPENCHAMBER_DATA_DIR`). VS Code uses `<globalStorage>/harness/journal/`. Pass `--dir <journal-dir>` to the CLI for either host.
- Layout: `index.json` summarizes `sessions/<sessionID>/manifest.json`; closed chunks are `*.ndjson.gz`, the active crash-safe chunk is plain `*.ndjson.open`, large strings are `blobs/<sha256>.txt.gz`, and records without a resolvable session are under `runtime/`. The directory's generated `README.md` is the self-describing format guide.
- Legacy root `*.ndjson` segments coexist during the transition. They remain readable, are listed as `legacy`, are pruned before session buckets, and are removed by Clear All Data; they are never regrouped.
- `message.part.delta` is intentionally absent. Repeated `message.part.updated` and `session.updated` records are last-write-wins; `coalesced` reports how many source events a stored record represents. These trims are not data-loss gaps. `gap` still means queue overflow, sanitization failure, or parse failure and must qualify conclusions.
- Record types remain `open_code_event`, `prompt`, `control`, `lifecycle`, `worktree_transition`, `evidence_transition`, `connection`, `timing`, `log`, and `gap`. Resolved session IDs are stamped at the top level before storage.
- Runtime health: `GET /api/diagnostics/status` (default port 3000; `dev:server` uses `${OPENCHAMBER_PORT:-3001}`) reports `sessionCount`, bytes, queue/write/gap counts, segment count, and the last error.
- Caveats: records and manifests are sanitized before disk (secrets redacted, home/worktree paths rewritten to `<WORKTREE_…>` placeholders); retention is 7 days / 1 GiB total (256 MiB in VS Code). Absence of an expected non-delta record is itself evidence — the runtime never saw it.
- Deep contracts: `packages/harness-runtime/DOCUMENTATION.md` (journal, sanitizer, export, storage limits) and `packages/web/server/lib/diagnostics/DOCUMENTATION.md` (HTTP status/clear/export/sanitize).

## Regression-prevention checklist

- When adding fallback logic, ask: can stale persisted data keep this path active forever?
- When deriving UI state, ask: is this live state, historical state, or inferred state?
- When adding store fields, ask: who reads this, how often does it change, and should it live elsewhere?
- When touching polling or bootstrap, ask: can a lighter payload erase richer existing data?
- When handling optimistic updates, ask: where is rollback, reconciliation, and duplicate prevention?
- When changing shared routes or state contracts, ask: what breaks in web, desktop, and VS Code?
- When fixing a bug with a heuristic, prefer narrowing the heuristic over widening it.

## Validation expectations

- Default for small, low-risk code changes: run `bun run validate:quick` before finalizing. This lints changed TypeScript files, type-checks directly affected packages, and only runs tests when changed files are test files or quick-mode rules require them.
- For package-local changes where dependents or package-wide linting matter, run `bun run validate:affected`. This expands UI changes to dependent web/VS Code type-checks and runs tests for affected UI/server code paths.
- Run `bun run validate:full` or the explicit full commands (`bun run type-check`, `bun run lint`, and `bun run test:full`) for release work, dependency/config changes, package exports, build tooling, cross-runtime contracts, risky sync/server/session changes, or whenever changed-file detection reports shared validation config changes.
- Existing full commands remain valid: `bun run type-check` and `bun run lint` still run workspace-wide validation.
- Also run `bun run build` when touching package exports, Vite/build config, Electron or VS Code packaging paths, dynamic imports, dependency graph changes, or files that could affect bundling.
- Also run `bun run --cwd packages/web test` when touching `packages/web/server/**`, server libraries, CLI behavior, test files, or shared server contracts if `validate:affected` was not already used.
- Validation examples: UI copy change → `bun run validate:quick`; server route change → `bun run validate:affected`; shared UI state change → `bun run validate:affected`; root config change → `bun run validate:full`.
- Add focused runtime/manual checks only for the changed surface: user-visible UI behavior, state synchronization, streaming/session flows, Electron/VS Code shell integration, or other paths where static checks cannot prove behavior.
- For hot-path changes, verify behavior under streaming or repeated events when those paths are affected.
- For sync or startup changes, verify fresh load, retry/failure, and restart behavior when those paths are affected.
- For session changes, verify create, stream, abort, permission, archive/delete, and revisit flows when those paths are affected.

## Recent changes

- Release history lives in GitHub Releases.
- Recent commits: `git log --oneline` (latest tags: `v1.4.6`, `v1.4.5`)
