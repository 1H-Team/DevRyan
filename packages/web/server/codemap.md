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
- **Question route ownership**: `lib/opencode/question-routes.js` is registered before the generic OpenCode proxy. It merges OpenCode and Cursor pending cards, resolves Cursor replies/Skip locally, translates verified OpenCode Skip requests into ordered best-judgment replies so the active turn resumes, forwards unknown IDs unchanged, and marks Cursor-only partial snapshots for bounded UI recovery.
- **Cursor title ownership**: `lib/opencode/cursor-session-title-runtime.js` schedules guarded, asynchronous Cursor Auto titles after intercepted prompts and preserves manual session renames.
- **Standard-provider title ownership**: `lib/opencode/standard-session-title-runtime.js` schedules guarded, asynchronous Zen summaries after successful proxied prompts; it captures the session identity before the generic proxy clears Express route params and preserves explicit/manual session names.
- **Loopback-safe route tests**: `test-supertest.js` targets the address family actually bound by each ephemeral test server, preventing unrelated IPv4 listeners from receiving requests when Node selects an IPv6 port with the same number.
- **Managed orchestration owner**: `lib/orchestration/` owns one durable three-slot scheduler for web and in-process Electron, an authenticated private OpenCode bridge, safe UI routes/events, and deterministic shutdown. See `lib/orchestration/DOCUMENTATION.md`.

## Flow
1. Parse CLI/runtime options (`lib/opencode/cli-options.js`) and initialize config/state runtimes.
2. Build Express app + middleware (security, auth, compression, request guards).
3. Register route groups from lib modules (`opencode`, `notifications`, `tts`, `quota`, `git`, etc.).
4. Start upstream OpenCode integration, event-stream fanout, terminal runtime, scheduled tasks, and tunnel wiring.
5. Expose shutdown hooks for graceful server + child-process teardown.

## Integration
- Consumed by: `packages/web/bin/cli.js` and Electron main process import path.
- Depends on: Express, ws, http-proxy-middleware, simple-git, web-push, OAuth/GitHub/OpenCode SDK utilities, `@openchamber/cursor-sdk-runtime`, and `@openchamber/orchestration-runtime`.
- Publishes HTTP + SSE + WS contracts consumed by `packages/ui` through `packages/web/src/api/*` adapters.
