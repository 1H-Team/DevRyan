# packages/web/server/lib/preview/

## Responsibility
Preview and standalone-web Browser routing: project preview grants, navigation policy, target/session isolation, resource-noise filtering, and bridge script injection.

## Design
- `proxy-runtime.js` is policy-heavy and framework-aware (Vite/Next/Astro/etc. noise suppression rules).
- `project-instances-runtime.js` owns the in-memory project grant registry. Registration requires an owned terminal in the canonical directory plus a reachable loopback HTTP(S) app. A server single-flight sweep keeps the rolling lease alive while that exact terminal and listener remain live; grants are shared only within the assigned project and disappear on terminal exit, revocation, failed liveness, or shutdown. Administrator registrations resolve canonical registered repository/worktree containment so the host administrator does not need a personal project assignment.
- Classification helpers are pure functions (`classifyPreviewResourceError`, `classifyPreviewNavigation`) to keep route/websocket layer thin.
- In-page bridge script captures console/runtime signals and forwards them to parent preview shell.
- `normalizeProxyTargetUrl` gates registration to loopback origins. Browser and Preview proxy targets are project-preview-only; non-loopback Browser registrations return `browser_external_target_requires_client` before DNS or outbound proxy work.
- Dev-server CSP headers are rewritten (`rewritePreviewCspHeader`), not dropped: frame-ancestors/require-trusted-types-for removed, one per-response nonce shared between the rewritten CSP and the injected bridge script; meta-delivered CSP is stripped from HTML.
- Body rewriting also covers inline `<script type="module">` import specifiers (Vite preamble), root-relative `url(...)` values in inline `<style>` blocks, and Inertia request/response headers (`applyPreviewPassthrough*Headers`). The injected app-request patch applies the same target-path routing to runtime `fetch`/XHR/EventSource calls, dynamically assigned resource attributes/properties and SPA-created CSS URLs after loopback URL virtualization.
- Only redirect/HTML/CSS/JavaScript responses are buffered for rewriting. Fonts, images, media, downloads, JSON, SSE, and other unchanged payloads stream directly with range/status/header fidelity so large files and long-lived responses do not block page loading.
- `local-instances-runtime.js` accepts only explicit loopback URLs already discovered from DevRyan terminals, probes their TCP listeners with a 500 ms timeout and bounded concurrency, and exposes per-candidate liveness without enumerating processes or scanning ports. Its legacy HTTP probe route is loopback-only; tunnel viewers must use project grants.
- `proxy-runtime.js` never provides public Browser egress. Local requests may register loopback targets directly; tunnel/unknown-public loopback requests need a live project grant. Every project target is bound to the authenticated app/tunnel session as well as its path-scoped HttpOnly token, including supported WebSockets.
- Browser clients use `/api/browser/*` aliases that require the effective
  Browser capability. Targets created there retain that restriction for every
  subsequent HTTP and HMR WebSocket request. `/api/preview/*` remains the
  independent Preview contract.
- Local-scope trust requires both a loopback peer and the raw HTTP `Host` header to be loopback; forwarded hostname metadata cannot promote a public request to local trust.
- Same-origin redirects are rewritten through the target path. Cross-origin HTTP(S) document redirects become same-origin handoff documents: Browser asks the client to open the destination, while Preview retains its regular-browser handoff. Only document/iframe navigations may receive a handoff; subresource redirects keep their real 3xx status and absolute `Location`. Alternate loopback pivots remain rejected, and forwarded `Origin`/`Referer` headers are rebuilt for the authoritative project origin without proxy ids or internal Browser query keys.
- Registering an origin that already has a live target for the same owner, scope, and grant reuses that target's id and token and extends its lifetime. The proxy path scopes every upstream cookie, so minting a fresh id on the client's pre-expiry refresh would sign the embedded page out and remount the frame mid-session.
- `__Host-`/`__Secure-` cookies cannot satisfy their prefix rules under a rewritten path, so they cross the viewer origin wrapped in a `__ocproxy-` marker and are restored byte-exactly upstream; a marker-named upstream cookie is dropped as ambiguous. On an insecure viewer origin (loopback still counts as secure) `Secure` is dropped and `SameSite=None` becomes `Lax`, since the browser would otherwise refuse the cookie outright.
- Rewritten HTML drops `integrity` attributes: bodies are modified and upstream compression is disabled, so every recorded subresource hash would mismatch and the browser would block the asset.
- The injected WebSocket shim routes generic same-target application sockets as well as framework HMR sockets through the authenticated target path. Cross-origin sockets remain viewer-side.

## Flow
1. A background UI owner registers terminal-discovered project apps through `/api/preview/instances/register` independently of Browser presentation; assigned Browser-capable users list shared live endpoints through `GET /api/browser/instances` without receiving terminal IDs or host paths. The Preview aliases remain independent of Browser capability.
2. Incoming preview requests resolve/protect target loopback origins. Tunnel target registration verifies a matching project grant; HTTP and WebSocket requests verify both session ownership and the target cookie.
3. Navigation events are classified as allow/proxy/external.
4. Resource load failures are filtered to suppress dev-server noise while reporting actionable failures.
5. The injected bridge posts console, runtime/resource errors, navigation, and element metadata to the shared Preview/Browser diagnostics client.

## Integration
- Consumed by `/api/preview/*`, capability-gated `/api/browser/*`, `ContextPanel`, and the standalone-web Browser surface/pop-out.
- Coordinates with session auth cookies and proxy routing in the main server runtime.
- Terminal lifecycle callbacks revoke source grants immediately.
