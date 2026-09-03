# Production Bots governed-egress proxy

See `docs/BOTS_RUNTIME.md` for the complete runtime trust model.

Reasoning and computer containers have no direct public network path. Model,
registered AG-UI agent-endpoint, and browser HTTP/CONNECT traffic passes through
this proxy using purpose-separated short-lived runtime
capability in `Proxy-Authorization`. Direct clients may use `Bearer`; standard
proxy URL clients use Basic credentials with the fixed username `devryan` and
the signed capability as the password. Both resolve to the same token verifier.

The capability is HMAC authenticated and binds a deployment, Bot, revision,
purpose, exact normalized `host:port` set or browser `public_only` mode,
issuance time, expiry, and nonce. The AG-UI adapter separately verifies the
registered connection digest before requesting an endpoint token. Model and
browser verification also requires the revision to remain active; agent health
checks may run for a draft connection before activation. Tokens expire after at
most 15 minutes;
an inactive, unknown, expired, malformed, or unverifiable revision fails with
proxy authentication required. Model provider credentials continue to use the
ordinary upstream `Authorization` header and are never interpreted as proxy
credentials.

Before any upstream socket is opened, the proxy:

1. checks the active-revision purpose and exact authority/network policy;
2. rejects local/single-label sibling names and known metadata names;
3. resolves all A/AAAA answers once;
4. rejects the request if any answer is loopback, RFC1918/ULA, link-local, LAN,
   metadata, multicast, documentation, benchmarking, or otherwise reserved;
5. connects to the reviewed address directly while retaining the original TLS
   server name and HTTP Host header.

This blocks wildcard destinations and DNS-rebinding fallbacks. Browser
`public_only` accepts public destinations after the same address checks;
`allowlist` requires an exact normalized hostname and optional port. Redirects
are not followed by the AG-UI client, and browser redirects are re-evaluated as
new proxy requests. Only this proxy joins the public-NAT network.

The computer hosts a loopback relay whose only authority is the current browser
token; that lets the host rotate a revision-bound capability without restarting
Chromium or exposing it through Chromium command-line arguments. Chromium uses
the relay as an explicit proxy, disables QUIC, and disables the implicit
loopback bypass. Proxy failure therefore disables browser networking instead of
falling back to direct container egress.

## Private gateway relay

Reasoning and computer containers join internal networks only, so they cannot
open a socket to the host at all. Their authenticated private-gateway calls
arrive here instead, on the same in-network address as the proxy, and this
service relays them to the host loopback gateway. It is the one Bot-facing
service already bridged to the host.

The host address arrives on the separately authenticated control channel
(`POST /v1/gateway/origin`) and is never accepted from a relayed request: it
must be an `http://host.docker.internal:<port>` origin with no credentials,
path, query, or fragment. Until it is published the relay answers 503, so a
container can reach the gateway the deployment pinned and nothing else on the
host loopback.

Only the four gateway routes are relayed; any other path is refused here rather
than forwarded, so the relay never becomes a general HTTP client aimed at the
host. The upstream header set is built from scratch rather than filtered: the
`Host` the gateway checks, the caller's bearer capability, the declared body
shape, and a staged filename. Nothing a container sends can smuggle a cookie or
a forwarding header past it, and only a reviewed response header set comes back.
Bodies and responses are streamed under per-route bounds that mirror the
gateway's own maxima, so the relay is never the narrower limit. The gateway
still authenticates every call: the relay carries a capability, it does not
grant one.

The standalone image starts fail-closed. Electron publishes the service on an
ephemeral loopback port and activates the current `(Bot, revision)` pair through
`POST /v1/revisions/activate` with the purpose-separated
`DEVRYAN_BOT_EGRESS_CONTROL_TOKEN`. Dynamic containers never receive that
control token. A new active revision for the same Bot replaces the old one;
every proxy request still rechecks the signed token's 15-minute expiry and the
live pair. `DEVRYAN_BOT_ACTIVE_REVISIONS` remains a fixed bootstrap mechanism
for controlled integration environments.

Run tests with `bun test packages/bot-egress`.
