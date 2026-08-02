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
- Cursor SDK and managed orchestration;
- diagnostics, evidence, worktrees, providers, and quota;
- Git, GitHub, terminal, skills, plugins, MCP, notifications, and TTS;
- browser preview/CDP, CLI/tunnels/auth, packaging, release branding, validation, bundle budgets, and agent evaluations;
- product-tool discovery, permission aliases, provider prompt policy, presentation families, state/target rendering, activity grouping, unknown-tool fallback, and managed-task replacement cards.

Tool tests intentionally describe stable policy and presentation families instead of enumerating every possible plugin tool. A newly discovered tool must remain visible through the safe generic fallback.

## Fixture rules

Deterministic suites must use temporary directories, injected dependencies, or loopback-only fake services. Tests must not require credentials, live providers, external network access, the user's configuration, or installed-app state. Always clean up temporary files and child processes, including failure paths.

Use narrow fixtures that state the contract being exercised. Preserve public compatibility identifiers such as `@openchamber/*`, `OPENCHAMBER_*`, `openchamber://`, config paths, and event names. DevRyan branding assertions apply to public release filenames and user-facing release metadata.

Do not silence a deterministic scenario with `skip` or `todo`. Remove tests for deleted behavior, or rewrite them around the current contract. Nondeterministic/manual validation belongs in release or audit documentation, not the required unit/integration gate.
