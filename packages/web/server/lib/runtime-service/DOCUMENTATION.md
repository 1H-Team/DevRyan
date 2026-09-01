# Local runtime-service HTTP contract

This module exposes the narrow loopback control plane used when the signed
Electron executable runs as a launchd-owned Production Bots service. Ownership,
descriptor persistence, protocol generations, and OS-sealed token rotation live
in `packages/electron/runtime-service.mjs`; this module owns only Express route
authentication and typed forwarding.

`POST /auth/runtime-service-bootstrap` accepts one bounded token only from a
loopback peer with `X-DevRyan-CSRF: 1`. Successful consumption rotates the
bootstrap and mints a 12-hour `devryan_runtime_service` cookie with `HttpOnly`,
`SameSite=Strict`, and `Path=/`. Replays fail. Every route except the narrow
health check then requires that cookie; every unsafe method also requires the
CSRF header.

The public handshake contains only instance ID, loopback port, protocol version,
health, owner generation, bounded desktop-host capability names/expiry, and
update time. It never exposes bootstrap/session/broker tokens. The desktop app
may register one 30-second broker lease for `focus`, `notifications`,
`browser_cdp`, and `browser_observation`; expiry or explicit release makes those
capabilities unavailable without stopping the service. Observation is
negotiated independently so a previous foreground host leaves browser control
working while the remote view reports unavailable.

Bot runtime control forwards only `status`, `operation`, `setup`, `repair`,
`update`, and `rollback`. Disable and update-preparation routes invoke injected
checkpoint/drain ownership callbacks. No route accepts Docker arguments, image
references, paths, ports, data-directory selection, or arbitrary callback
names.

The windowless owner has no renderer IPC event target. Foreground Bot UI reads
`operation` repeatedly only while the returned phase is nonterminal, stops on
`ready` or `failed`, and refreshes `/api/bots/capabilities` after that terminal
transition. The operation route remains a read-only snapshot; it does not start,
retry, or cancel Docker work.

Run the contract tests with:

```bash
bun test packages/web/server/lib/runtime-service/routes.test.js
```
