# Tunnels Module Documentation

## Purpose
This module contains tunnel provider orchestration for OpenChamber, including provider registry/service wiring, managed remote token config lifecycle, and tunnel HTTP route registration.

## Entrypoints and structure
- `packages/web/server/lib/tunnels/index.js`: tunnel service orchestration.
- `packages/web/server/lib/tunnels/registry.js`: provider registry.
- `packages/web/server/lib/tunnels/managed-config.js`: managed remote tunnel token/preset persistence runtime.
- `packages/web/server/lib/tunnels/managed-token.js`: authoritative parser for raw Cloudflare tunnel tokens and supported Cloudflare-generated connector commands.
- `packages/web/server/lib/tunnels/origin-relay.js`: loopback-only raw TCP relay for a stable managed-remote Cloudflare origin port.
- `packages/web/server/lib/tunnels/public-reachability.js`: bounded public-hostname verification against the current DevRyan runtime instance.
- `packages/web/server/lib/tunnels/routes.js`: tunnel API route registration and request orchestration runtime.
- `packages/web/server/lib/tunnels/types.js`: tunnel constants, normalization, and shared type helpers.
- `packages/web/server/lib/tunnels/providers/cloudflare.js`: Cloudflare tunnel provider implementation.

Managed remote tunnel tokens are normalized by `managed-token.js` both before configuration persistence and immediately before cloudflared launch. Persisted configuration and generated token files therefore contain raw tokens only, while the launch boundary also recovers supported legacy command-form values.

## Managed remote origin contract

Managed-remote profiles use schema version 2 and include `originPort` (default `3000`). The
Cloudflare dashboard service remains fixed at `http://127.0.0.1:<originPort>`. When DevRyan's
active web port differs, `origin-relay.js` binds only IPv4 loopback and forwards raw TCP bytes to
the active port, preserving HTTP, SSE, and WebSocket traffic. No relay is created when both ports
match.

The relay is bound before `cloudflared` starts and remains open until the connector exits. Port
conflicts fail with `managed_remote_origin_port_in_use` before connector launch. Managed profile
files are replaced atomically with mode `0600`; schema-v1 entries migrate to origin port `3000`
without rewriting token values.

Each server process has an in-memory random instance ID exposed only in the
`X-DevRyan-Instance-ID` response header on `/health` and `/api/health`. After cloudflared reports a
connection, `public-reachability.js` probes the public hostname for at most 15 seconds and requires
that exact header. A timeout, DNS failure, Cloudflare 502/1033-style response, or mismatched
instance returns `managed_remote_public_unreachable` before the tunnel is reported ready.

Controller reuse is identity-bound to provider, mode, normalized hostname, origin port, and an
in-memory token digest. Reused controllers are publicly verified again before direct account access
is reported ready. During initial startup, a public verification failure accompanied by a cloudflared QUIC
failure triggers exactly one connector restart with `--protocol http2`; there is no retry loop.
Provider metadata exposes only safe origin and lifecycle state: `cloudflareOriginUrl`,
`activeOriginUrl`, `originRelayActive`, `publicReachabilityVerified`, `connectorState`,
`effectiveTransportProtocol`, `lastPublicVerificationAt`, `lastPublicVerificationAttemptAt`,
`publicReachabilityReason`, and `lastPublicStatus`. `localOriginUrl`, `transportProtocol`, and
`cloudflareConfigRequiresManualOriginMatch` remain compatibility aliases for one release.

The status route performs a cached single-attempt public probe for managed-remote controllers.
Failures mark the controller `degraded`. Unexpected connector
exit clears the service controller and active tunnel authentication artifacts; an explicit stop
continues to wait for process exit before clearing either.

Tunnel start is also gated by authoritative OpenCode readiness. Manual starts return
`503 runtime_not_ready` before connector launch or managed-token persistence. Cold startup awaits
the OpenCode bootstrap before launching a configured connector. An already-connected Cloudflare
connector remains visible during a later OpenCode restart, but `runtimeReady` and `connectReady`
become false and clients must show the stable hostname as unavailable until readiness returns.
Start and status responses expose both booleans. For managed-remote mode, `connectReady` requires a
ready runtime, a non-degraded connector, and Supabase-backed managed-account login; no browser
bootstrap token is created. A connector left running from a legacy shared-password configuration
remains visible with its saved token and preset intact, but reports `connectReady: false`.

## Link routing contract

Managed-remote tunnels use direct account login at their stable public hostname and return
`policy: account-login`; startup is rejected with `managed_account_auth_required` unless Supabase
multi-user auth is configured. The legacy shared UI password is deliberately ineligible because it
cannot attribute remote developers to separate durable owners. Public `/auth/*` and `/api/*`
requests use managed-account authentication, fail closed with the same deterministic code when a
legacy connector is still running, and never issue a `/tunnel/connect` link.

Quick and managed-local tunnels retain one-time links at `/tunnel/connect?t=...`; multi-user access
invitations use `/invite?t=...`. `/connect` remains a compatibility dispatcher for previously
issued links. It recognizes the current tunnel token by its in-memory digest—including after use
or expiry—before considering the invitation flow, so a tunnel token can never be reinterpreted as
an invitation. The exchange pre-commit cleanup and retry semantics remain unchanged for those
legacy/link-gated modes.

## Shutdown contract

Tunnel shutdown is asynchronous and process-authoritative. Provider controllers first send
`SIGINT`, wait for the connector to exit, then escalate to `SIGTERM` and `SIGKILL` with bounded
grace periods. `createTunnelService().stop()` keeps the active controller registered until the
provider confirms exit and coalesces concurrent stop requests onto the same promise.

The `/api/openchamber/tunnel/stop` route waits for that promise before revoking bootstrap/session
artifacts or clearing the active tunnel identity. If the connector cannot be stopped, the route
returns `tunnel_stop_failed` and preserves both controller and authentication state; this prevents a
still-public connector from being reclassified as a local unauthenticated request path.

## Public exports (routes.js)
- `createTunnelRoutesRuntime(dependencies)`: creates tunnel routes runtime and helpers.
- Returned API:
  - `registerRoutes(app)`
  - `startTunnelWithNormalizedRequest(request)`
