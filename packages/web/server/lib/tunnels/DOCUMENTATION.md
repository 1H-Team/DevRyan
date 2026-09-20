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
exit suspends the service controller and live connections while preserving durable sessions; an explicit stop
continues to wait for process exit before clearing either.

Tunnel start is also gated by authoritative OpenCode readiness. Manual starts return
`503 runtime_not_ready` before connector launch or managed-token persistence. Cold startup awaits
the OpenCode bootstrap before launching a configured connector. An already-connected Cloudflare
connector remains visible during a later OpenCode restart, but `runtimeReady` and `connectReady`
become false and clients must show the stable hostname as unavailable until readiness returns.
Start and status responses expose both booleans. For managed-remote mode, `connectReady` requires a
ready runtime, a non-degraded connector, and either configured managed-account login or
a locally issued Bot workspace link. Starting a connector without selecting Bots is
allowed, but does not issue a link or grant access.

## Link routing contract

With Supabase enabled, managed-remote tunnels retain individual account login.
With Supabase Off or absent, an authenticated local owner can start the connector
and issue links for selected Bot workspaces. A database outage never changes the
startup authentication policy.

`access-control.js` is the production authority, initialized before private native
routes, the disconnected boundary, proxies, or WebSocket handlers. Direct-local
classification uses the socket, raw Host and matching Origin, rejecting all
`forwarded`, `x-forwarded-*` and `cf-*` headers. An inactive connector never makes
a remote peer local. Only requests recorded in this boundary's private WeakSet
can pass the disconnected boundary. Terminal, OpenCode and preview WebSocket
handlers also honor the early upgrade rejection.

Links use `/tunnel/connect#t=...`. GET renders a landing page, removes the fragment
from history and exchanges nothing. Connect sends a same-origin, CSRF-protected
POST. Tokens expire within 15 minutes and are single-use. Fixed seven-day sessions
and hashed link credentials live in the private encrypted authorization vault.
Sessions bind owner, grant, selected Bot UUIDs, durable profile, hostname and
authorization generation. Raw credentials do not enter server logs or referrers.
Two fixed installation/tunnel buckets limit exchanges without trusting forwarding headers.

The explicit `tunnel-bot` principal has no administrator or host capabilities.
`bot-grants.js` allows only enumerated Bot catalog, conversation, attachment, run,
approval and isolated computer routes. Membership and channel ACLs still apply,
including action/run channel checks and SSE filtering. Host terminal/files/Git,
agent sessions, previews, imports, credentials, settings, tunnel control and
native capabilities are denied before handlers. Shared UI mounts only Bot state
and its event owner for this principal.
Persisted UI state is namespaced by grant as well as owner, so replacing a link
cannot restore cached conversations from another grant or the owner's account.

Normal restart resumes the saved managed-remote profile with its existing connector
configuration and preserves unexpired sessions. Recovery suspends live connections
without deleting sessions. Stop, grant revocation, owner changes, authentication-mode
changes and hostname changes invalidate authorization and close associated streams.
Expired/lost sessions require another locally issued link; remote passkey enrollment
is unsupported. `POST /api/openchamber/tunnel/links` issues a selected-Bot link;
`DELETE /api/openchamber/tunnel/grants/:grantId` revokes one. Both require direct-local
owner authentication and CSRF protection.

Electron enrolls an absent local owner through its in-process server handle or
authenticated runtime-service bootstrap. Standalone web owners explicitly run
`openchamber enroll-owner --port <port>` with the matching `OPENCHAMBER_DATA_DIR`.
The private filesystem challenge expires after two minutes and is consumed only
by a loopback, same-origin POST. Visiting localhost cannot enroll an owner. Missing
or corrupt vault/key state fails closed; restore the matching pair to recover access.
After enrollment, CLI tunnel commands prove filesystem ownership through a new
one-use challenge and retain their owner cookie only in memory. They cannot
silently enroll a new owner. About reports failed On startup as a connection
failure while preserving On and its managed authentication policy.

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
