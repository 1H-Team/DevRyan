# packages/web/server/lib/security/

## Responsibility
Request-level security helpers for cookie token extraction, origin allowlisting, explicit WebSocket upgrade rejection responses, and the shared proxy-forwarding predicate used to decide whether a request arrived directly.

## Design
- `direct-local-request.js` is the production local-authority check shared by owner authentication and Bot tunnels: raw socket, raw Host, matching Origin and no forwarding/Cloudflare provenance headers, even empty ones.
- `createRequestSecurityRuntime` is dependency-injected so origin policy can include persisted settings (`publicOrigin`).
- Cookie parsing and origin checks are strict/defensive; malformed values fail closed.
- WebSocket rejection writes explicit HTTP response bytes before socket destroy for predictable client diagnostics.
- `forwarded-request.js` owns the single list of proxy/tunnel forwarding headers. Locality decisions read the raw Host header and treat any forwarding header as proof of indirection, because `trust proxy` would otherwise let a client-supplied `X-Forwarded-Host` drive `req.hostname`, and a tunnel always presents a loopback socket peer.

## Flow
1. Caller reads `oc_ui_session` token from request cookies for UI-authenticated channels.
2. Origin validator builds candidate origins from host/forward headers plus configured public origin.
3. Disallowed upgrades are terminated with status-specific plaintext response.

## Integration
- Used by websocket and sensitive API entrypoints in the web server runtime.
- Depends on settings persistence readers to include runtime-configured origin aliases.
- `hasForwardingHeaders` is shared by `lib/opencode/tunnel-auth.js` (`classifyRequestScope`) and `lib/multi-user/supabase-connection.js` (`isDirectLocalRequest`) so the two locality boundaries cannot drift apart.
