# packages/web/

## Responsibility
Web runtime package that ships the main app plus mini-chat and detachable-browser Vite entries, the embedded Express server runtime, and the `openchamber` CLI entrypoint.

## Design
- **Split runtime model**: UI bootstrap in `src/`, server orchestration in `server/`, operator/automation UX in `bin/`.
- **Adapter boundary**: `src/api/*` implements `@openchamber/ui` runtime API contracts over HTTP/WebSocket endpoints.
- **Composable server internals**: `server/index.js` delegates to focused runtime factories under `server/lib/*` instead of keeping route logic inline.
- **Deterministic browser chunking**: `vite-chunking.ts` strips query/hash suffixes before resolving the innermost `node_modules` package across npm, Bun, pnpm, and Windows IDs; `vite.config.ts` assigns only the intentional React/Zustand/OpenCode/Markdown/Base UI/syntax vendor groups and emits a Vite manifest for startup-budget checks.

## Flow
1. `bin/cli.js serve` (or Electron import) calls server bootstrap in `server/index.js`.
2. Server starts OpenCode integration + local APIs (`/api/*`, SSE, WS) and serves web assets.
3. Browser loads `src/main.tsx`, installs runtime APIs via `window.__OPENCHAMBER_RUNTIME_APIS__`, then imports `@openchamber/ui/main`.
4. Shared UI talks to web APIs (terminal, git, files, settings, notifications, GitHub, push, tools).

## Integration
- Exposes package entrypoints: `main`/`types` => `server/index.js`, `bin` => `bin/cli.js`.
- Serves `@openchamber/ui` frontend runtime and consumes `@opencode-ai/sdk` via server-side OpenCode integration.
- Used directly by Electron desktop shell (in-process server boot) and standalone CLI/web deployments.
- Browser build output is measured from `dist/.vite/manifest.json` by the root bundle-budget checker; generated `dist` files remain untracked build artifacts.
