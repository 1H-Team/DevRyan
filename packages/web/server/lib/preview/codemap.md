# packages/web/server/lib/preview/

## Responsibility
Preview and standalone-web Browser routing: project preview grants, navigation policy, target/session isolation, resource-noise filtering, and bridge script injection.

## Design
- `proxy-runtime.js` is policy-heavy and framework-aware (Vite/Next/Astro/etc. noise suppression rules).
- `project-instances-runtime.js` owns the in-memory project grant registry. Registration requires an owned terminal in the canonical directory plus a reachable loopback HTTP(S) app. Grants are shared only within the assigned project and disappear on terminal exit, revocation, expiry, failed liveness, or shutdown.
- Classification helpers are pure functions (`classifyPreviewResourceError`, `classifyPreviewNavigation`) to keep route/websocket layer thin.
- In-page bridge script captures console/runtime signals and forwards them to parent preview shell.
- `normalizeProxyTargetUrl` gates registration: loopback-only by default; the `allowExternal` flag (blocked-literal guard, no DNS-rebinding defense) is never exposed through request payloads and nothing passes it today.
- Dev-server CSP headers are rewritten (`rewritePreviewCspHeader`), not dropped: frame-ancestors/require-trusted-types-for removed, one per-response nonce shared between the rewritten CSP and the injected bridge script; meta-delivered CSP is stripped from HTML.
- Body rewriting also covers inline `<script type="module">` import specifiers (Vite preamble) and forwards Inertia request/response headers (`applyPreviewPassthrough*Headers`).
- `local-instances-runtime.js` accepts only explicit loopback URLs already discovered from DevRyan terminals, probes their TCP listeners with a 500 ms timeout and bounded concurrency, and exposes per-candidate liveness without enumerating processes or scanning ports. Its legacy HTTP probe route is loopback-only; tunnel viewers must use project grants.
- `proxy-runtime.js` keeps public and private network hosts out of the server proxy. Local requests may register loopback targets directly; tunnel/unknown-public requests need a live project grant. Every target is bound to the authenticated app/tunnel session as well as its path-scoped HttpOnly token, including HMR WebSockets.
- Local-scope trust requires both a loopback peer and the raw HTTP `Host` header to be loopback; forwarded hostname metadata cannot promote a public request to local trust.
- Same-origin redirects are rewritten through the target path; redirects that pivot to another origin or port are rejected. Forwarded `Origin`/`Referer` headers are rebuilt for the authoritative loopback origin without proxy ids or internal Browser query keys.
- The injected WebSocket shim routes generic same-origin application sockets as well as framework HMR sockets through the authenticated target path. Public and cross-origin sockets remain viewer-side.

## Flow
1. Terminal-discovered project apps register short-lived grants through `/api/preview/instances/register`; assigned users list shared live endpoints through `GET /api/preview/instances` without receiving terminal IDs or host paths.
2. Incoming preview requests resolve/protect target loopback origins. Tunnel target registration verifies a matching project grant; HTTP and WebSocket requests verify both session ownership and the target cookie.
3. Navigation events are classified as allow/proxy/external.
4. Resource load failures are filtered to suppress dev-server noise while reporting actionable failures.
5. The injected bridge posts console, runtime/resource errors, navigation, and element metadata to the shared Preview/Browser diagnostics client.

## Integration
- Consumed by `/api/preview/*`, `ContextPanel`, and the standalone-web Browser surface/pop-out.
- Coordinates with session auth cookies and proxy routing in the main server runtime.
- Terminal lifecycle callbacks revoke source grants immediately.
