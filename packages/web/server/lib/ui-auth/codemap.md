# packages/web/server/lib/ui-auth/

## Responsibility
UI authentication and session security layer: login/session JWT cookies, passkey integration, trusted-device TTL handling, and brute-force rate limiting.

## Design
- **Controller factory** (`createUiAuth`) encapsulates auth state and exposes middleware-like helpers.
- **Rate-limiter with per-key locks** prevents concurrent mutation races in in-memory attempt counters.
- **Session-token contract**: signed JWT in a port-scoped cookie (`oc_ui_session_<port>`) with secure-request-aware cookie policy.
- **Passkey submodule** (`ui-passkeys.js`) isolates WebAuthn credential operations.
- **Shared-host bridge**: the raw passkey verification hook does not issue the
  legacy JWT; multi-user mode may exchange a successful loopback-only
  verification for its own opaque administrator app session.

## Flow
1. Login request enters rate-limit gate and credential/passkey verification path.
2. On success, module issues session cookie/JWT and clears limiter state.
3. Protected routes call `ensureSessionToken`/token readers for auth context.
4. Periodic cleanup prunes stale rate-limit records and lockout entries.

## Integration
- Consumed by notification/push/session routes and core auth/access route registrars.
- Uses JOSE for JWT signing/verification and local config files for auth persistence.
- Provides session identity primitive used across server and UI runtime APIs.

- `session-cookie.js` derives the standalone cookie name and JWT audience from the trusted accepted socket's listening port. Host and forwarded headers never choose it. Login/passkeys/CSRF/WebSocket/CLI/proxy readers share this boundary; legacy shared cookies are ignored. Managed account sessions keep their separate contract.
- JWT and WebAuthn modules load on first use through shared import promises. Endpoint validation and error behavior remain owned here.
