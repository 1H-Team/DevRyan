# packages/web/server/lib/

## Responsibility
Service-layer modules for server features (OpenCode lifecycle, auth, shared-host identity/authorization, managed bug/error review, event streaming, terminal protocol, git/GitHub, durable harness diagnostics/evidence, notifications, tunnels, quotas, project scheduling, scoped assistant image assets, session-plan storage, file search, and the authenticated local runtime-service contract).

## Design
- **Domain segmentation** by directory (`opencode/`, `multi-user/`, `bots/`, `event-stream/`, `terminal/`, `git/`, `github/`, `image-assets/`, `skills-catalog/`, etc.).
- **Production Bots control plane**: `bots/runtime.js` composes explicit
  Supabase repositories, active membership/channel authorization, encrypted
  private Storage objects, capability projection, and content-free audit
  retention. `bots/encryption.js` owns exact AES-256-GCM envelopes;
  `bots/credential-vault.js` owns the atomic private host-local connector vault
  and produces secret-free Supabase metadata. The same composition root owns
  immutable revision compilation, selected-provider/registered-agent credential
  brokering, fixed Electron Docker callbacks, agent-neutral reasoning lifecycle, continuous
  encrypted channels, durable per-scope FIFO dispatch/recovery, a separate
  principal-filtered Bot event stream, and the capability-bound loopback
  gateway. See `bots/DOCUMENTATION.md`.
- **Runtime service routes**: `runtime-service/routes.js` gates the launchd-owned
  loopback server with a rotating one-time bootstrap, HttpOnly/SameSite cookie,
  CSRF, a safe protocol/owner handshake, short desktop-host lease, and fixed Bot
  runtime operations. See `runtime-service/DOCUMENTATION.md`.
- **Pure helpers + runtime wrappers**: validation/normalization helpers are separated from side-effectful runtime objects.
- **Dependency injection** through constructor-style functions (`create...Runtime`) to keep modules testable and shell-agnostic.
- **Route registration pattern** for feature modules exposing `register*Routes(app, deps)`.
- **Release authority**: `package-manager.js` reads the latest stable DevRyan
  release from `1H-Team/DevRyan`; `OPENCHAMBER_UPDATE_API_URL` remains an
  explicit compatibility override rather than the default source. Automatic
  update checks use asynchronous, single-flight package-manager detection;
  terminal detection and update execution retain their synchronous entrypoints.

## Flow
1. `server/index.js` imports factories/registrars from this directory.
2. It creates runtime instances with Node primitives and process/env config.
3. Routes call domain modules (read/update config, spawn tools, proxy OpenCode, emit SSE/WS events).
4. Shared modules (`multi-user`, `event-stream`, `ui-auth`, `security`) enforce principal, ownership, transport, and access invariants across features.

## Integration
- Internal dependency hub for `packages/web/server/index.js`.
- Exposes API contracts consumed by web UI runtime adapters and desktop shells.
- Integrates external systems: Supabase Auth/PostgREST, git binaries, GitHub OAuth APIs, OpenCode server, cloud tunnel providers, OS TTS tooling.
