# packages/web/server/

## Responsibility
Primary backend runtime for DevRyan web/desktop: starts Express, wires OpenCode process lifecycle/proxying, and exposes filesystem/git/terminal/session/notification/tunnel APIs.

## Design
- **Thin orchestrator**: `index.js` owns composition and shared state; module behavior lives in `lib/*` factories.
- **Runtime factory pattern**: many modules expose `create*Runtime(...)` to inject fs/path/process/network dependencies.
- **Protocol-aware transport**: explicit handling for SSE, WS, proxy timeouts, and compression exclusions for streaming routes.
- **Local cache policy**: `lib/http-cache-policy.js` marks dynamic `/api/*` responses as `no-store` so Electron/Chromium profiles do not persist session/message/git/preview API payloads.
- **Cross-surface support**: same backend serves standalone web and embedded desktop runtime.
- **Cursor SDK split**: `index.js` composes `@openchamber/cursor-sdk-runtime`; `lib/opencode/routes.js` intercepts `cursor-acp` prompt sends and virtual provider discovery while quota routes keep using the existing dashboard usage token.
- **Cursor title ownership**: `lib/opencode/cursor-session-title-runtime.js` schedules guarded, asynchronous Cursor Auto titles after intercepted prompts and preserves manual session renames.

## Flow
1. Parse CLI/runtime options (`lib/opencode/cli-options.js`) and initialize config/state runtimes.
2. Build Express app + middleware (security, auth, compression, request guards).
3. Register route groups from lib modules (`opencode`, `notifications`, `tts`, `quota`, `git`, etc.).
4. Start upstream OpenCode integration, event-stream fanout, terminal runtime, scheduled tasks, and tunnel wiring.
5. Expose shutdown hooks for graceful server + child-process teardown.

## Integration
- Consumed by: `packages/web/bin/cli.js` and Electron main process import path.
- Depends on: Express, ws, http-proxy-middleware, simple-git, web-push, OAuth/GitHub/OpenCode SDK utilities, and `@openchamber/cursor-sdk-runtime`.
- Publishes HTTP + SSE + WS contracts consumed by `packages/ui` through `packages/web/src/api/*` adapters.
