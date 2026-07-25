# Tunnels Module Documentation

## Purpose
This module contains tunnel provider orchestration for OpenChamber, including provider registry/service wiring, managed remote token config lifecycle, and tunnel HTTP route registration.

## Entrypoints and structure
- `packages/web/server/lib/tunnels/index.js`: tunnel service orchestration.
- `packages/web/server/lib/tunnels/registry.js`: provider registry.
- `packages/web/server/lib/tunnels/managed-config.js`: managed remote tunnel token/preset persistence runtime.
- `packages/web/server/lib/tunnels/managed-token.js`: authoritative parser for raw Cloudflare tunnel tokens and supported Cloudflare-generated connector commands.
- `packages/web/server/lib/tunnels/routes.js`: tunnel API route registration and request orchestration runtime.
- `packages/web/server/lib/tunnels/types.js`: tunnel constants, normalization, and shared type helpers.
- `packages/web/server/lib/tunnels/providers/cloudflare.js`: Cloudflare tunnel provider implementation.

Managed remote tunnel tokens are normalized by `managed-token.js` both before configuration persistence and immediately before cloudflared launch. Persisted configuration and generated token files therefore contain raw tokens only, while the launch boundary also recovers supported legacy command-form values.

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
