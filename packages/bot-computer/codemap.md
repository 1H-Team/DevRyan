# Bot computer codemap

`@openchamber/bot-computer` is the persistent Chromium service used only by
Production Bot computer scopes. It has no dependency on the ordinary DevRyan
browser panel or OpenCode browser tools.

## Entry points

- `src/server.js` composes the authenticated HTTP service, exposes the
  exact-shape host-only egress-token rotation route, and owns graceful
  browser/display/server shutdown.
- `Dockerfile` installs Chromium and Xvfb, switches to UID/GID 10001, and
  exposes only the internal health/command port.

## Modules

- `auth.js` — timing-safe bearer authentication.
- `browser.js` — the reviewed agent command inventory, fixed 1280×720/DSF1
  headed Chromium viewport, strict human-only input-event validator, narrow
  ordered CDP driver, and sanitized lifecycle/network event hooks. Its
  `createHumanInputDispatcher` owns bounded held-key/button state, old-batch
  generation fencing, per-event authority checks, and bounded input release.
- `display.js` — local-only 24-bit Xvfb startup, readiness, supervision, and
  bounded shutdown.
- `browser-diagnostics.js` — memory-only origin/status/failure aggregation with
  no paths, queries, headers, cookies, page content, or input data.
- `managed-policy.js` — startup verification for the exact root-owned mandatory
  JavaScript/cookie policy.
- `chromium-policies/managed/devryan-browser.json` — root-owned image policy
  that keeps JavaScript plus first- and third-party cookies enabled without
  mutating persistent Bot profiles.
- `egress-proxy.js` — loopback authenticated relay into bot-egress with
  runtime-token rotation and no direct fallback.
- `refs.js` — page-generation-fenced opaque accessibility references.
- `control.js` — actor-attributed renewable human-control leases plus the
  immediate agent pre-execution fence used by durable host wait/resume. Return
  and expiry retain the fence until the driver's registered input-release hook
  succeeds; failed cleanup remains explicit and owner-retryable.
- `screencast.js` — in-memory fan-out of bounded JPEG frames plus verified
  viewport metadata, with no retention.
- `profiles.js` — persistent browser profile and per-lease scratch lifecycle.
- `workspace.js` — gateway-only private artifact upload/download staging.

## Where to change things

- Add or alter a browser command only in `browser.js` and its tests; never add
  an arbitrary JavaScript/CDP passthrough.
- Keep direct coordinate input human-only and lease-gated; never add `input` to
  the reasoning agent's reviewed command list.
- Change HTTP routes or authentication in `server.js` and `auth.js`.
- Change profile/scratch tenancy rules in `profiles.js`.
- Change JavaScript or cookie availability in the managed Chromium policy and
  `managed-policy.js`; do not expose script or cookie inspection commands.
- Change virtual-display lifecycle only in `display.js`; health must fail closed
  and Chromium must never fall back to headless mode.
- Change file-transfer limits or object gateway paths in `workspace.js`.
- Change browser proxy/rotation behavior in `egress-proxy.js`; the computer
  network must remain internal, QUIC disabled, and implicit loopback bypass off.
  Keep the authenticated rotation contract in `server.js` synchronized with it.

Every source module has a colocated Bun test. The Docker-backed fixture browser
group in `browser.test.js` is opt-in because it builds and runs Chromium.
