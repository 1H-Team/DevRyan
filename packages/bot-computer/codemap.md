# Bot computer codemap

`@openchamber/bot-computer` is the persistent Chromium service used only by
Production Bot computer scopes. It has no dependency on the ordinary DevRyan
browser panel or OpenCode browser tools.

## Entry points

- `src/server.js` composes the authenticated HTTP service, exposes the
  exact-shape host-only egress-token rotation route, and owns graceful
  browser/server shutdown.
- `Dockerfile` installs Chromium, switches to UID/GID 10001, and exposes only
  the internal health/command port.

## Modules

- `auth.js` — timing-safe bearer authentication.
- `browser.js` — the reviewed command inventory and the narrow CDP driver.
- `egress-proxy.js` — loopback authenticated relay into bot-egress with
  runtime-token rotation and no direct fallback.
- `refs.js` — page-generation-fenced opaque accessibility references.
- `control.js` — actor-attributed human control leases and agent pausing.
- `screencast.js` — in-memory fan-out of bounded JPEG frames with no retention.
- `profiles.js` — persistent browser profile and per-lease scratch lifecycle.
- `workspace.js` — gateway-only private artifact upload/download staging.

## Where to change things

- Add or alter a browser command only in `browser.js` and its tests; never add
  an arbitrary JavaScript/CDP passthrough.
- Change HTTP routes or authentication in `server.js` and `auth.js`.
- Change profile/scratch tenancy rules in `profiles.js`.
- Change file-transfer limits or object gateway paths in `workspace.js`.
- Change browser proxy/rotation behavior in `egress-proxy.js`; the computer
  network must remain internal, QUIC disabled, and implicit loopback bypass off.
  Keep the authenticated rotation contract in `server.js` synchronized with it.

Every source module has a colocated Bun test. The Docker-backed fixture browser
group in `browser.test.js` is opt-in because it builds and runs Chromium.
