# packages/web/server/lib/tunnels/providers/

## Responsibility
Provider implementations for tunnel lifecycle operations; currently hosts Cloudflare provider capability/diagnostics/start behavior.

## Design
- Provider object contract: `{ id, capabilities, checkAvailability, diagnose, start }`.
- `cloudflare.js` separates mode metadata (`quick`, `managed_remote`, `managed_local`) from runtime checks and declares fixed-origin support for managed remote mode.
- Diagnostics produce per-mode structured checks (pass/warn/fail) with explicit blockers.

## Flow
1. Tunnel service selects provider by ID.
2. Provider runs dependency/network/config checks and returns readiness details.
3. `start()` dispatches to mode-specific Cloudflare tunnel starters with normalized inputs; managed remote passes the fixed origin port and runtime instance identity.
4. Compatibility and verification hooks decide whether an active controller can be reused safely.

## Integration
- Depends on `lib/cloudflare-tunnel.js` for concrete process/network operations.
- Consumed by higher-level tunnels runtime and API routes for availability probes and tunnel creation.
