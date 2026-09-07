# DevRyan agent guidance

DevRyan provides web and Electron interfaces to OpenCode over HTTP and SSE. This repository is the source of truth for DevRyan.

## Boundaries

- Work only inside `/Users/zoubair/Repositories/DevRyan` unless the user authorizes another path in the current task. Canonical repository: `1H-Team/DevRyan`.
- Do not read, browse, clone, compare, or modify upstream OpenChamber repositories or checkouts (`openchamber/openchamber`, `btriapitsyn/openchamber`, `../openchamber`, or equivalents) without explicit permission in the current task. Do not access `../opencode` without that permission either.
- `@openchamber/*`, `openchamber`, `OPENCHAMBER_*`, configuration paths, and protocol names are compatibility identities. Preserve them; they do not authorize upstream access. OpenCode is the supported external runtime dependency.
- Editor extensions are unsupported. Do not add an extension workspace, publisher, or release artifact.
- Never add secrets, log sensitive data, or type/store/transmit passwords. Use the password-free agent-test login for authorized live verification.
- Preserve the user's work and keep changes within the requested outcome. No new dependencies unless requested.

## Architecture and navigation

- Shared UI lives in `packages/ui`; the web feature backend lives in `packages/web/server`. Shared runtime packages own their documented cross-host contracts. Keep entrypoints thin and use focused modules.
- New desktop work belongs in `packages/electron`. Electron starts the web server in-process, or connects to its owned runtime service; do not introduce a sidecar feature backend. The shell owns native integrations and browser/runtime-service facilities.
- `packages/desktop` is legacy Tauri, retained for released-install auto-update compatibility. Add no features or speculative backports there. The cutover is a separate user decision: [migration runbook](docs/TAURI_TO_ELECTRON_CUTOVER.md).
- Shared UI uses runtime capabilities and the preload compatibility bridge; preserve intentional web/Electron contracts rather than branching on shell identity.
- Use [CODEMAP.md](CODEMAP.md) when locating unfamiliar ownership or entrypoints. Follow the relevant folder codemap or module documentation when its contracts matter. A small edit in a known file does not require reading the entire map or unrelated documents.
- Update the relevant codemap and documentation when changing ownership, entrypoints, or contracts. Use package manifests and lockfiles for current versions and commands.

## Implementation

- Prefer the smallest correct change and nearby conventions. Preserve working behavior and avoid unrelated refactors.
- Enforce safety and correctness in core logic, not only in UI or prompts. Make partial failures, rollback, and recovery explicit.
- Use authoritative live state for activity; use history to restore context. Keep transient fallbacks scoped to the active entity and clear them when live state arrives.
- Preserve references for unchanged shared state, use narrow subscriptions, and avoid expensive work on streaming paths. For UI/sync changes, consult the applicable [performance guidance](docs/AGENT_PERFORMANCE.md).
- Reuse Base UI wrappers and shared primitives. Use theme variables and `packages/ui/src/lib/typography.ts`; import toasts from `@/components/ui`, not directly from `sonner`.
- Use typed boundaries; avoid `any`, blind casts, and guessed payload shapes. Prefer function components, explicit branches, and early returns.
- For terminal CLI behavior, preserve validation and deterministic nonzero failures across TTY, noninteractive, quiet, JSON, and fully specified flags. See [CLI policy](docs/CLI_POLICY.md).

## Verification and completion

- Finish implementation, relevant verification, and cleanup within the authorized task. Continue through reversible corrections needed for that outcome; ask only for missing intent or actions outside existing authorization.
- The deterministic local suites use disposable fixtures and must not access production, credentials, live providers, or the user's installed-app state. Run them and fix change-related failures without seeking approval for each retry. Live/Docker/native checks have separate prerequisites in [TESTING.md](docs/TESTING.md) and [QA.md](docs/QA.md).
- Choose validation by impact: `bun run validate:quick` for small low-risk code edits; `bun run validate:affected` for package behavior and dependents; `bun run validate:full` for dependencies, build/config, exports, shared contracts, risky sync/server/session work, and releases. Full validation already includes workspace lint, type checks, and deterministic tests; do not repeat those commands without a new reason.
- Documentation-only edits use `bun run docs:validate`. Bundled agent/skill prompts also need their owning package's contract tests because they are runtime assets.
- Run `bun run build` when dependencies, bundling, dynamic imports, exports, or packaging inputs change; use `bun run bundle:check` for startup bundle verification. Add runtime/visual checks where static tests cannot establish changed behavior.
- Report what passed, failed, or was unavailable. Do not weaken assertions, suppress failures, or call an unavailable platform/signing/live check a pass.

## Runtime incidents and live checks

- For reported runtime issues (stuck sessions, failed prompts, abort/stream/sync anomalies, worktree or evidence lifecycle), inspect the diagnostic journal before forming a code-only theory. Resolve Error Log UUIDs through the administrator detail API first, then correlate session and call/tool/message/task IDs; run the journal gap check before concluding.
- Use [runtime verification](docs/AGENT_RUNTIME_VERIFICATION.md) for journal commands, retention limits, the password-free agent-test accounts, and isolated verification-server setup. Report missing or expired evidence explicitly.
- Keep live verification isolated from the user's running app and data. Do not stop their runtime or Docker Engine to satisfy a test.

## Release invariants

- Public GitHub Release assets and directly downloadable workflow artifacts must use `DevRyan` branding. Tool-mandated metadata such as `latest-mac.yml` and internal handoff artifacts may keep functional names.
- Stage compatibility-derived outputs under deterministic `DevRyan-*` names before release upload. npm/package identities may remain compatible.
- Release verification must require branded filenames and reject legacy-prefixed assets and extension packages. Preserve signed-image and artifact checks; do not substitute development manifests for release evidence.
