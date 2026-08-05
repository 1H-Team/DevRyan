# packages/web/server/lib/tunnels/

## Responsibility
Public tunnel management subsystem: provider registry, tunnel mode/intent typing, request normalization/validation, and managed configuration support.

## Design
- **Provider registry pattern** (`registry.js`) enforces required provider capabilities (`start/stop/checkAvailability/resolvePublicUrl`).
- **Strong request normalization** (`types.js`) canonicalizes provider/mode/intent/token/hostname/configPath.
- **Capability-driven validation**: request validity depends on provider-declared mode requirements.
- **Managed config runtime** persists remote/local managed tunnel presets and lifecycle metadata.
- **Stable managed origin** (`origin-relay.js`) binds `127.0.0.1:<originPort>` and forwards raw TCP to the active DevRyan port.
- **Public instance verification** (`public-reachability.js`) requires the current process's health header before readiness.

## Flow
1. API/CLI receives tunnel request (quick or managed modes).
2. `normalizeTunnelStartRequest` + `validateTunnelStartRequest` sanitize and enforce constraints.
3. Registry resolves concrete provider implementation (currently Cloudflare).
4. Provider runtime starts/stops tunnel; stop waits for confirmed connector exit with bounded signal
   escalation before service/auth state is cleared.
5. Managed-remote startup binds the stable origin relay, starts the connector, and verifies the public hostname reaches this process.
6. Managed config runtime atomically persists schema-v2 profile state (`originPort`, default `3000`) with private permissions.

## Integration
- Used by `server/index.js` tunnel routes and CLI tunnel commands.
- Provider implementations live under `tunnels/providers/*`.
- Integrates with OpenCode project directory and auth/settings normalization pipelines.
