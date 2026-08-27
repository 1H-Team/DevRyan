# packages/web/server/lib/browser-cdp/

## Responsibility
Authenticated desktop-only browser control boundary: read-only legacy bridge discovery plus session-turn-scoped lease acquisition, activity, and release.

## Design
- The bridge itself lives in the Electron main process (`packages/electron/browser-cdp-bridge.mjs`); this module owns server-side lease identity, OpenCode lineage scope, and private HTTP authorization.
- Status and the expected bearer token arrive as injected callbacks from the Electron host, never from `process.env` reads: the OpenCode child copies env once at spawn and cannot observe later parent mutations, so the token is minted at Electron startup and passed to the child at spawn while the live ws URL is fetched through this route.
- Deny-by-default: loopback peer required (checked via `req.socket.remoteAddress`, not proxy-supplied headers, because the app sets `trust proxy`), bearer required, no caching, no permissive CORS. Web/remote runtimes supply no callbacks, so the route 404s.
- The private capability routes register after the bounded common JSON parser but before the generic UI `/api` authentication middleware. Managed OpenCode has no browser cookie; its loopback peer, bearer, and lease scope are the complete machine-to-machine authorization boundary, while ordinary UI APIs remain principal-authenticated.
- Responses use deterministic states — `disabled`, `no_target`, `debugger_conflict`, `ready` — so an agent can branch without parsing prose. A ws URL is only ever emitted for `ready`.
- `lease-runtime.js` resolves child-to-root session lineage from OpenCode with a bounded, directory-aware 100-entry session-lifetime parent LRU and per-node singleflight, serializes exact `opencodeSessionID + messageID` acquisition, and fences stale host callbacks. Successful lineage survives transient OpenCode outages until session deletion or managed-runtime reset; unseen nodes retry only network/timeout/5xx failures twice, while authoritative missing/mismatched/cyclic/depth-invalid lineage fails immediately without fallback. It checks injected host availability before both reuse and creation so a disabled host deterministically returns `agent_browser_disabled` and retires any stale reusable record. Electron's missing-owner race maps to `browser_owner_context_unavailable`, distinct from a generic `browser_host_unavailable` failure.
- Lease scope is `{ rootSessionId, opencodeSessionID, messageID, directory, agent }`. Reuse, touch, and release require the exact normalized current-session turn, directory, and agent. `session.idle`, `session.deleted`, and `session.error` release only leases owned by that exact OpenCode session.

## Flow
1. The bundled `devryan_browser` tool POSTs `/api/desktop/browser-leases` with its authoritative tool context and managed bearer.
2. The runtime validates peer + bearer, resolves the root session, reuses the exact turn lease when present, and asks Electron to create a guest otherwise.
3. The tool touches the lease around each command and DELETEs it on explicit `close`; authoritative session lifecycle events, managed OpenCode process replacement, and graceful shutdown are fallback cleanup. Managed replacement increments the admission epoch, aborts and drains old-epoch lineage/acquisition work, releases every old lease, holds admission closed while the child is replaced, and resumes only after replacement completes (including the failure path).
4. `/api/desktop/browser-cdp` remains the validated managed discovery anchor used to derive the private server origin; its scalar bridge status is compatibility-only.

## Integration
- Registered by `server/index.js` through the base-route bootstrap's private-capability hook so UI authentication cannot intercept the managed bearer.
- Electron injects create/touch/release callbacks; standalone web and VS Code omit them and receive 404.
- `packages/web/server/default-config/plugins/devryan-browser.mjs` is the only managed model-facing lease client.
