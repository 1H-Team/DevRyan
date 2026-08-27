# packages/web/server/lib/runtime-service/

- `routes.js`: loopback-only one-time bootstrap, HttpOnly/SameSite cookie and
  CSRF gate, safe versioned handshake, short desktop-host lease, and fixed Bot
  runtime/disable/update control routes.
- `routes.test.js`: replay, cookie, CSRF, token non-projection, and bounded
  desktop-host lease contracts.
- `DOCUMENTATION.md`: security and ownership boundary for this module.
