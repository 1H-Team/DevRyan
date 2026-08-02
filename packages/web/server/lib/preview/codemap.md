# packages/web/server/lib/preview/

## Responsibility
Preview proxy runtime utilities for embedded app previews: navigation policy, resource-noise filtering, target/session token handling, and bridge script injection.

## Design
- `proxy-runtime.js` is policy-heavy and framework-aware (Vite/Next/Astro/etc. noise suppression rules).
- Classification helpers are pure functions (`classifyPreviewResourceError`, `classifyPreviewNavigation`) to keep route/websocket layer thin.
- In-page bridge script captures console/runtime signals and forwards them to parent preview shell.
- `normalizeProxyTargetUrl` gates registration: loopback-only by default; the `allowExternal` flag (blocked-literal guard, no DNS-rebinding defense) is never exposed through request payloads and nothing passes it today.
- Dev-server CSP headers are rewritten (`rewritePreviewCspHeader`), not dropped: frame-ancestors/require-trusted-types-for removed, one per-response nonce shared between the rewritten CSP and the injected bridge script; meta-delivered CSP is stripped from HTML.
- Body rewriting also covers inline `<script type="module">` import specifiers (Vite preamble) and forwards Inertia request/response headers (`applyPreviewPassthrough*Headers`).
- `local-instances-runtime.js` accepts only explicit loopback URLs already discovered from DevRyan terminals, probes their TCP listeners with a 500 ms timeout and bounded concurrency, and exposes per-candidate liveness without enumerating processes or scanning ports.

## Flow
1. Incoming preview requests resolve/protect target loopback origins.
2. Navigation events are classified as allow/proxy/external.
3. Resource load failures are filtered to suppress dev-server noise while reporting actionable failures.
4. Injected bridge posts UI/runtime telemetry back to host context.
5. The Electron blank-browser launcher posts its current-project terminal candidates to `/api/preview/local-instances/status`; invalid and unreachable entries stay out of the launcher.

## Integration
- Consumed by `/api/preview/*` server routes and preview iframe host logic.
- Coordinates with session auth cookies and proxy routing in the main server runtime.
