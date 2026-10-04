# packages/web/

## Responsibility
Web runtime package that ships the main app plus mini-chat and detachable-browser Vite entries, the embedded Express server runtime, and the `openchamber` CLI entrypoint.

## Design
- **Split runtime model**: UI bootstrap in `src/`, server orchestration in `server/`, operator/automation UX in `bin/`.
- **Adapter boundary**: `src/api/*` implements `@openchamber/ui` runtime API contracts over HTTP/WebSocket endpoints.
- **Composable server internals**: `server/index.js` delegates to focused runtime factories under `server/lib/*` instead of keeping route logic inline.
- **Deterministic browser chunking**: `vite-chunking.ts` strips query/hash suffixes before resolving the innermost `node_modules` package across npm, Bun, pnpm, and Windows IDs; `vite.config.ts` assigns the intentional React/Zustand/OpenCode/Markdown/Base UI/syntax vendor groups and emits a Vite manifest for startup-budget checks. The small markup utilities shared by eager consumers and lazy Markdown live separately in `vendor-markup-utils`, preventing an eager import of the full Markdown dependency group.

## Flow
1. `bin/cli.js serve` (or Electron import) calls server bootstrap in `server/index.js`.
2. Server starts OpenCode integration + local APIs (`/api/*`, SSE, WS) and serves web assets.
3. Browser loads `src/main.tsx`, installs runtime APIs via `window.__OPENCHAMBER_RUNTIME_APIS__`, then imports `@openchamber/ui/main`.
4. Shared UI talks to web APIs (terminal, git, files, settings, notifications, GitHub, push, tools).

## Integration
- **Test runners**: `test` runs web contracts in Vitest, then the original native helper, quiet-retention, and queued-input service graphs in Bun. These `bun:test` files are excluded from Vitest and included in the same package gate; `scripts/test-suite-contract.test.mjs` verifies that dispatch.
- Exposes package entrypoints: `main`/`types` => `server/index.js`, `bin` => `bin/cli.js`.
- Serves `@openchamber/ui` frontend runtime and consumes `@opencode-ai/sdk` via server-side OpenCode integration.
- Used directly by Electron desktop shell (in-process server boot) and standalone CLI/web deployments.
- Browser build output is measured from `dist/.vite/manifest.json` by the root bundle-budget checker; generated `dist` files remain untracked build artifacts.

- `vite-terminal-assets.ts` verifies vendored terminal binary digests and includes its license/provenance files in `dist/licenses/terminal` for web and Electron packaging.

Native v2 packaging uses only manifest-listed `DevRyan-*` controller/writer/assets
and the accepted execution launcher under `runtime/<platform>-<arch>`. No v1
executable or companion manifest enters the npm closure. The current reviewed
build/signature platform is Darwin ARM64; universal web publication remains
unavailable until every required native platform has reviewed build/verification
evidence. This does not restrict the package's declared user platforms or treat
missing platform checks as passes. `scripts/pack-web-release.mjs` gates both the
source and unpacked artifact before release.
