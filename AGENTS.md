# DevRyan agent guidance

DevRyan is the web and Electron interface to OpenCode over HTTP and SSE. Canonical repository: `1H-Team/DevRyan`.

## Hard rules

- Work only inside this repository unless the user authorizes another path in the current task. Do not read, clone, compare or modify upstream OpenChamber (`openchamber/openchamber`, `btriapitsyn/openchamber`, `../openchamber`) or `../opencode` without explicit permission in the current task.
- Preserve the compatibility identities `@openchamber/*`, `openchamber`, `OPENCHAMBER_*`, configuration paths and protocol names. They do not authorize upstream access.
- No new dependencies unless requested. No editor extensions.
- Never add secrets, log sensitive data, or type, store or transmit passwords. Use the password-free agent-test login ([runtime verification](docs/AGENT_RUNTIME_VERIFICATION.md)) for live checks.
- New desktop work goes in `packages/electron`. `packages/desktop` is frozen legacy Tauri, kept only for released-install compatibility ([cutover runbook](docs/TAURI_TO_ELECTRON_CUTOVER.md)).
- No `codemap.md` files.
- Commit with explicit `git add <paths>`; other sessions leave work in the tree.
- The public release is exactly one `DevRyan-<version>-arm64.dmg`. Do not break `/releases/latest` updater discovery or upgrades from installed 2.0.x apps ([release pipeline](docs/RELEASE_PIPELINE.md)).

## Code

- Shared UI is `packages/ui`; the web backend is `packages/web/server`; shared runtime packages own their documented contracts. Find ownership through package manifests, entrypoints and the nearest `DOCUMENTATION.md`, and update that file when you change an owner, entrypoint or contract.
- Electron starts the web server in-process or connects to its own runtime service; do not add a sidecar backend. Shared UI uses runtime capabilities and the preload bridge, not shell-identity branches.
- Make the smallest correct change in the surrounding style. Enforce safety in core logic, not only in UI or prompts, and make partial failure and recovery explicit.
- Use typed boundaries: no `any`, blind casts or guessed payload shapes. Use Base UI wrappers, theme variables and `packages/ui/src/lib/typography.ts`; import toasts from `@/components/ui`.
- Keep streaming paths cheap: stable references, narrow subscriptions ([performance guidance](docs/AGENT_PERFORMANCE.md)). Terminal CLI behaviour follows the [CLI policy](docs/CLI_POLICY.md).

## Verify

- `bun run validate` is the gate before every push and release tag. It lints and type-checks what changed, runs the affected package tests and always the startup contract, and fails if the run left new scratch in `.cache/`. CI runs `bun run validate:full` on every push to `main`.
- Tests and QA delete their scratch on success, failure and interruption. Use the OS temp dir (`scratchParent()` in `scripts/qa/run-root.mjs`); only tools that must stay inside the repository write under `.cache/`. Keep a failed run's files only with `--keep-artifacts` or `DEVRYAN_KEEP_ARTIFACTS=1`. `bun run cache:prune` previews `.cache` cleanup.
- Fix failures your change causes. Never weaken an assertion or skip a test. Report what passed, what failed and what you could not run.
- Live, Docker and native checks have their own prerequisites: [TESTING.md](docs/TESTING.md), [QA.md](docs/QA.md). Keep them isolated from the user's running app and data.

## Diagnostic journal

For a reported runtime issue (stuck session, failed prompt, abort, stream or sync anomaly), read the diagnostic journal before forming a code-only theory. Resolve Error Log UUIDs through the administrator detail API, correlate session, call, tool, message and task IDs, and run the journal gap check before concluding. Commands: [runtime verification](docs/AGENT_RUNTIME_VERIFICATION.md).
