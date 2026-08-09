# packages/web/server/

## Responsibility
Primary backend runtime for DevRyan web/desktop: starts Express, wires OpenCode process lifecycle/proxying, and exposes authenticated filesystem/git/terminal/session/notification/tunnel APIs. When Supabase configuration is present, it also composes the shared-host identity and authorization control plane.

## Design
- **Thin orchestrator**: `index.js` owns composition and shared state; module behavior lives in `lib/*` factories.
- **Runtime factory pattern**: many modules expose `create*Runtime(...)` to inject fs/path/process/network dependencies.
- **Protocol-aware transport**: explicit handling for SSE, WS, proxy timeouts, and compression exclusions for streaming routes.
- **Local cache policy**: `lib/http-cache-policy.js` marks dynamic `/api/*` responses as `no-store` so Electron/Chromium profiles do not persist session/message/git/preview API payloads.
- **Indexing policy**: `lib/indexing-policy.js` applies `X-Robots-Tag` to every response and serves a non-cacheable, deny-all `/robots.txt` before application routes.
- **Runtime ownership boundary**: `lib/runtime-port-visibility.js` prevents public server handles from exposing ports owned by skipped or external OpenCode runtimes.
- **Cross-surface support**: same backend serves standalone web and embedded desktop runtime.
- **Cursor SDK split**: `index.js` composes `@openchamber/cursor-sdk-runtime`; `lib/opencode/routes.js` intercepts `cursor-acp` prompt sends and virtual provider discovery, while quota routes independently resolve environment/token-file, managed OAuth/dashboard, and legacy dashboard credentials.
- **Question route ownership**: `lib/opencode/question-routes.js` is registered before the generic OpenCode proxy. It merges OpenCode and Cursor pending cards, resolves Cursor replies/Skip locally, translates verified OpenCode Skip requests into ordered best-judgment replies so the active turn resumes, forwards unknown IDs unchanged, and marks Cursor-only partial snapshots for bounded UI recovery.
- **Cursor title ownership**: `lib/opencode/cursor-session-title-runtime.js` schedules guarded, asynchronous Cursor Auto titles after intercepted prompts and preserves manual session renames.
- **Standard-provider title ownership**: `lib/opencode/standard-session-title-runtime.js` schedules guarded, asynchronous Zen summaries after successful proxied prompts; it captures the session identity before the generic proxy clears Express route params and preserves explicit/manual session names.
- **Loopback-safe route tests**: `test-supertest.js` targets the address family actually bound by each ephemeral test server, preventing unrelated IPv4 listeners from receiving requests when Node selects an IPv6 port with the same number.
- **Managed orchestration owner**: `lib/orchestration/` owns one durable, immediately admitting scheduler without an artificial concurrency cap for web and in-process Electron, an authenticated private OpenCode bridge, safe UI routes/events, and deterministic shutdown. See `lib/orchestration/DOCUMENTATION.md`.
- **Notification ownership**: `lib/notifications/runtime.js` gates and fans out completion, Plan Ready, error, question, and permission alerts; `lib/notifications/plan-ready.js` classifies settled actionable plan revisions from authoritative session messages. See `lib/notifications/DOCUMENTATION.md`.
- **Scoped plan storage**: `lib/plans/routes.js` owns deterministic session-plan create/read/update operations so managed developers can use plan workflows without access to generic filesystem APIs. See `lib/plans/DOCUMENTATION.md`.
- **Shared-host control plane**: `lib/multi-user/` owns opaque Supabase-backed app sessions, role/user policies, real-worktree containment and visibility grants, session ownership, per-user settings state, live revocation, actor audit, and administrator-only user analytics over that same audit store. `index.js` injects it ahead of feature routes and projects filtered OpenCode activity into its durable outbox. See `lib/multi-user/DOCUMENTATION.md`.

## Flow
1. Parse CLI/runtime options (`lib/opencode/cli-options.js`) and initialize config/state runtimes.
2. Initialize the optional multi-user runtime, then build Express middleware for security, principal resolution, CSRF, directory translation, and request guards.
3. Register route groups from lib modules (`opencode`, `notifications`, `tts`, `quota`, `git`, etc.) behind the applicable policy and ownership gates.
4. Start upstream OpenCode integration, ownership-filtered event-stream fanout, owner-bound terminal runtime, scheduled tasks, and tunnel wiring.
5. Expose shutdown hooks for graceful server + child-process teardown and durable outbox draining.

## Integration
- Consumed by: `packages/web/bin/cli.js` and Electron main process import path.
- Depends on: Express, ws, http-proxy-middleware, simple-git, web-push, OAuth/GitHub/OpenCode SDK utilities, `@openchamber/cursor-sdk-runtime`, and `@openchamber/orchestration-runtime`.
- Publishes HTTP + SSE + WS contracts consumed by `packages/ui` through `packages/web/src/api/*` adapters.
