# packages/bot-egress/

## Responsibility

Authenticated model, registered-agent-endpoint, and browser HTTP/CONNECT proxy.
Purpose-separated short-lived capabilities bind one deployment/Bot/revision to
an exact normalized host allowlist or browser public-only mode. DNS and address
policy denies local, private, LAN, metadata, sibling-container, reserved,
rebinding, and arbitrary targets.

## Entry points

- `src/server.js`: streaming HTTP and CONNECT proxy transport plus the
  separately authenticated active-revision registry/control route.
- `src/connect-policy.js`: authority parsing, exact allowlist checks, DNS
  rebinding defense, and public-address classification.
- `src/token.js`: signed runtime capabilities, host normalization, expiry, and
  active-revision verification.
- `Dockerfile`: non-root production image.

## Invariants

1. Proxy authentication uses `Proxy-Authorization`; upstream model
   `Authorization` remains separate.
2. Every new request/tunnel revalidates token expiry and purpose-specific
   network policy. Model/browser calls also revalidate the active Bot/revision;
   draft agent-connection health calls are separately digest-checked by the
   adapter.
3. Every resolved address must be public; one private DNS answer denies all.
4. Upstream sockets connect to the already-reviewed IP address to avoid a
   second DNS lookup.
5. Reasoning and computer containers have no direct public interface; only this
   service joins the public-NAT network. Chromium reaches it through a rotating
   loopback bearer relay.
6. Standard Basic proxy credentials require the fixed `devryan` username and
   carry the same signed token as the direct Bearer form.
