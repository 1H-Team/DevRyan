# Managed remote tunnels independent of Supabase connection

The reported “Auth” setting has no equivalent in this checkout, whose connection
control offers On and Off. Support the requested tunnel continuity in both modes.

## Plan

1. Trace manual startup, CLI, automatic resume, HTTP and WebSocket authentication.
   Require either managed account login or an enrolled owner in effective Off mode.
2. Reuse encrypted, expiring tunnel grants for an explicit owner link when Off.
   Preserve individual account login when On, Bot grant restrictions, local-only
   controls, public reachability checks, and revocation on mode/owner changes.
3. Remove the UI's managed-principal startup restriction. Display and copy the
   server-selected hostname or owner link; allow new owner links after resume.
4. Test start/status, authentication, expiry, restart, mode changes and revocation
   in disposable local fixtures. Run full validation, build and bundle checks.

## Evidence limits

No Error Log UUID was supplied. The live journal resides outside the authorized
repository scope; incident records and their gap check are unavailable. Local
regression tests establish the changed behavior without credentials, cloud calls,
or the user's running app. A live Cloudflare launch is a separate verification.

## Completed verification

- Full validation passed: workspace lint, type checks, documentation and all
  deterministic suites, including 4,375 web tests and the mounted tunnel UI flows.
- Changed-file lint and affected type checks passed after adding the UI regression.
- Web/Electron build and startup bundle budgets passed.
- Off/unconfigured owner login, On account login, start/status readiness, one-time
  exchange, HTTP/terminal WebSocket access, expiry, restart, logout, mode-change
  revocation, and rejected native/cloud/tunnel controls have regression coverage.
- Live Cloudflare verification and the user's installed-app restart were not run.
