# Repository Atlas: DevRyan

## Responsibility

DevRyan is a Bun/Node monorepo giving web and Electron interfaces to OpenCode over HTTP and SSE. Shared React UI lives in `packages/ui`, the feature backend in `packages/web/server`, and desktop integration in `packages/electron`.
Start at the nearest `codemap.md`; each row below names the owner of an area.

## Areas

| Path | Owns |
|---|---|
| `packages/ui/` | Shared React UI, stores, event-sync pipeline |
| `packages/web/` | Express server, browser bootstrap, `openchamber` CLI |
| `packages/web/server/lib/opencode/v2/` | OpenCode 2 client, facade routes, admission |
| `packages/electron/` | Desktop shell, runtime service, native integrations |
| `packages/desktop/` | Legacy Tauri shell for auto-update compatibility only |
| `packages/shared-runtime/` | Cross-host archive, config-apply, quota rules |
| `packages/orchestration-runtime/` | Managed-task contract and scheduler policy |
| `packages/harness-runtime/` | Durable operations, diagnostics, turn evidence |
| `packages/cursor-sdk-runtime/` | Shared Cursor SDK execution and auth helpers |
| `packages/bots-runtime/` | Bot JSON contracts, state machines, scoped image |
| `packages/bot-db/` | Local Bot catalog database and its images |
| `packages/bot-supervisor/` | Fixed-verb Docker lifecycle boundary |
| `packages/bot-engine-proxy/` | Sole Docker-socket process |
| `packages/bot-egress/` | Model, agent and browser network policy |
| `packages/bot-computer/` | Persistent Chromium service for Bots |
| `packages/bot-indexer/` | Disposable Bot retrieval index |
| `packages/docs/` | User-facing documentation site (no codemap) |
| `docker/` | Bot image and compose definitions |
| `scripts/` | Validation, QA, build, release automation |
| `tests/` | Visual fixtures, one codemap each |
| `docs/` | Runbooks and contracts (no codemap); `docs/audits/` holds evidence |

## Where To Change Things

- Entry points: `packages/web/server/index.js` (server), `packages/web/bin/cli.js` (CLI), `packages/ui/src/main.tsx` (UI), `packages/electron/main.mjs` (desktop).
- Validation, QA, build: `package.json`, `scripts/validate.mjs`, `scripts/qa/run.mjs`, `docs/TESTING.md`, `docs/QA.md`.
- Release and packaging: `docs/RELEASE_PIPELINE.md`, `.github/workflows/release.yml`, `scripts/build-native-runtime.mjs`.
- Production Bots: `docs/BOTS_RUNTIME.md` first, then the codemaps of the Bot packages above.
- Harness policy, diagnostics and optimization: `docs/HARNESS_OPTIMIZATION.md`, `packages/harness-runtime/codemap.md`.
- Conversation Revert and native confinement: `docs/CONCURRENT_REVERT.md`.
- Provider recovery and OAuth: `docs/PROVIDER_RECOVERY.md`, `docs/BOT_OAUTH_COORDINATION.md`.
- Windows preview: `docs/WINDOWS_PORT_PLAN.md`; desktop cutover: `docs/TAURI_TO_ELECTRON_CUTOVER.md`.
- Generated or bundled folders: change the source package, not the output.

## Related

`AGENTS.md`, `docs/AGENT_PERFORMANCE.md`, `docs/CLI_POLICY.md`, `docs/AGENT_RUNTIME_VERIFICATION.md`, `docs/audits/` for dated evidence.

## Codemap conventions

A codemap answers: where does X live, where do I start, what must callers not break.
- Limits: at most 60 lines, 6 KB, no line over 300 characters. A folder with 3 or fewer files gets no codemap; its parent lists it.
- Sections: `# <path>/`, `## Responsibility` (1-3 sentences), `## Entry points` (one line per file), `## Contracts` (numbered, about 10 cross-boundary rules), `## Where to change`, `## Related` (DOCUMENTATION.md, child codemaps, runbooks).
- Leave out dates, and release, dependency and OpenCode version numbers (link the manifest or constant).
- Leave out change narration; timeouts, caps, budgets, error-code and path lists (code comments or DOCUMENTATION.md); test and QA evidence (`docs/audits/`).
- References are root- or folder-relative paths with an extension; no braces or globs.
- Exemplars: `packages/bot-egress/codemap.md`, `packages/shared-runtime/codemap.md`, `packages/web/server/lib/evidence/codemap.md`.
- Enforced by `bun run docs:validate` via `scripts/docs/doc-shape.mjs`; exceptions only through `CODEMAP_SHAPE_EXCEPTIONS` with a reason and an until date.
