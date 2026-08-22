# packages/web/server/lib/

## Responsibility
Service-layer modules for server features (OpenCode lifecycle, auth, shared-host identity/authorization, managed bug/error review, event streaming, terminal protocol, git/GitHub, durable harness diagnostics/evidence, notifications, tunnels, quotas, project scheduling, scoped assistant image assets, session-plan storage, and file search).

## Design
- **Domain segmentation** by directory (`opencode/`, `multi-user/`, `event-stream/`, `terminal/`, `git/`, `github/`, `image-assets/`, `skills-catalog/`, etc.).
- **Pure helpers + runtime wrappers**: validation/normalization helpers are separated from side-effectful runtime objects.
- **Dependency injection** through constructor-style functions (`create...Runtime`) to keep modules testable and shell-agnostic.
- **Route registration pattern** for feature modules exposing `register*Routes(app, deps)`.
- **Release authority**: `package-manager.js` reads the latest stable DevRyan
  release from `1H-Team/DevRyan`; `OPENCHAMBER_UPDATE_API_URL` remains an
  explicit compatibility override rather than the default source.

## Flow
1. `server/index.js` imports factories/registrars from this directory.
2. It creates runtime instances with Node primitives and process/env config.
3. Routes call domain modules (read/update config, spawn tools, proxy OpenCode, emit SSE/WS events).
4. Shared modules (`multi-user`, `event-stream`, `ui-auth`, `security`) enforce principal, ownership, transport, and access invariants across features.

## Integration
- Internal dependency hub for `packages/web/server/index.js`.
- Exposes API contracts consumed by web UI runtime adapters and desktop shells.
- Integrates external systems: Supabase Auth/PostgREST, git binaries, GitHub OAuth APIs, OpenCode server, cloud tunnel providers, OS TTS tooling.
