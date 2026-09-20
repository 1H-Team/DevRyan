# packages/web/server/lib/runtime-service/

The early Bot tunnel boundary may admit Bot HTTP/SSE and static shell requests
without a desktop session cookie. Its private WeakSet is the only bypass proof;
native capabilities are denied before those requests reach this module. Upgrade
handlers honor prior rejection and never mint native or UI credentials remotely.

- `routes.js`: loopback-only one-time bootstrap, HttpOnly/SameSite cookie and
  CSRF gate, safe versioned handshake, short desktop-host lease (including the
  separately negotiated `browser_observation` capability), and fixed Bot
  runtime/disable/update control routes.
- `routes.test.js`: replay, cookie, CSRF, token non-projection, and bounded
  desktop-host lease contracts.
- `DOCUMENTATION.md`: security and ownership boundary for this module.
