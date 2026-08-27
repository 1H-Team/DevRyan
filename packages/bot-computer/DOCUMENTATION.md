# Persistent Production Bot computer

See `docs/BOTS_RUNTIME.md` for operational recovery, browser-write uncertainty,
and the revision-bound network/isolation policy.

This package runs one Chromium profile and persistent workspace per canonical
Bot computer scope. The only live scope is `bot:<botId>`. The Docker supervisor
publishes the Bot-scoped service on an ephemeral loopback-only host port;
short-lived run/channel gateway authority is supplied only on commands that
transfer private artifacts.

The container joins only the internal computer network. A loopback relay adds
the current purpose-separated browser capability and forwards to bot-egress;
Chromium receives only the relay URL. The relay token rotates without restarting
the persistent profile through the runtime-authenticated, exact-shape
`POST /v1/egress/rotate` control route. The host stops the owned computer if a
rotation cannot be confirmed, so a stale capability is never used as a fallback.
Chromium disables QUIC and its implicit loopback proxy
bypass, so an unavailable relay/proxy disables networking instead of permitting
direct container egress. `public_only` accepts only public destinations after
DNS/address checks; `allowlist` additionally requires an exact normalized host
and optional port.

## Command and authentication boundary

`GET /healthz` is the only unauthenticated route. Every `/v1/*` route requires
the exact runtime bearer capability. The egress-rotation route accepts only one
signed browser-purpose token and is called by the trusted host, never by the
reasoning endpoint. The agent command route accepts only:

`navigate`, `snapshot`, `click`, `fill`, `select`, `key`, `scroll`, `wait`,
`upload`, `download`, `screenshot`, and `close`.

There is deliberately no evaluate, script, raw CDP, shell, filesystem-path, or
generic browser endpoint. Snapshots turn backend DOM node IDs into opaque refs
bound to a page generation. Navigation/close invalidates all earlier refs.

## Persistence and private files

`/data/chromium` is a named profile volume so cookies and login state survive
container replacement. `/workspace` is a separate persistent named volume and
survives run changes, pause/resume, and container replacement until an explicit
reset or purge. Uploads are fetched from, and downloads are published to, the
authenticated private gateway using the current command's short-lived run
capability. Callers cannot nominate host paths.

Profile reset requires an explicit confirmation and closes Chromium before
deleting profile contents. Normal shutdown asks Chromium to close through CDP,
then uses bounded TERM/KILL fallback so the profile receives a graceful flush
whenever Chromium is responsive.

The controller owns a generation-fenced Chromium handle. Unexpected process
exit or CDP closure immediately invalidates the exact dead generation and its
accessibility refs; a late close notification cannot clear a newer driver.
Launches are singleflight. Safe browser reads retry once after relaunch, while
click, fill, select, key, and upload are never replayed. Status reports current
health, launch state, generation, and the last lifecycle failure code. Existing
screencast subscribers are reattached to a successfully relaunched driver.

Before a replacement launch, the service removes only Chromium's disposable
`DevToolsActivePort` and `Singleton*` startup artifacts. Cookies, preferences,
downloads, and every other profile file remain authoritative. This lets a
retained named profile open after a hard browser or container exit whose old
hostname can no longer release its singleton lock.

## Human control and screencast

Taking control creates a short actor-attributed lease. Heartbeat and return
must match the actor and lease ID; another actor receives a conflict. Agent
commands pause while the lease is active. Human commands require that lease;
passive MJPEG viewing is a separate runtime-bearer capability and never grants
control or pauses the agent.

Screencasting is subscriber-driven. Creating a viewer descriptor transmits no
pixels; attaching its one-use stream idempotently launches Chromium when an
Active Bot has not opened it yet. The first connected viewer starts one shared
CDP screencast, additional viewers share its in-memory fan-out, and the final
disconnect calls `Page.stopScreencast`. JPEG bytes are transient and are never
retained by this service.

Chromium runs with its internal sandbox disabled because the dynamic container
is the standard-tier security boundary: non-root UID/GID 10001, read-only rootfs,
no-new-privileges, all Linux capabilities dropped, Docker seccomp, bounded
resources, and a dedicated 1 GiB `/dev/shm`. Revision-v3 may request the
stronger `runsc` tier. The host must find `runsc` in Docker's declared runtimes
and pass an owned disposable no-network smoke container; otherwise publication
or startup fails with no standard-tier downgrade. Tier replacement closes
Chromium before recreating the container and retains the named profile volume.
Policy and mutating actions remain independently enforced by the private action
gateway.

Run unit tests with `bun test packages/bot-computer`. Set
`DEVRYAN_RUN_BROWSER_TESTS=1` for the Docker-backed fixture-browser group.
The Docker group kills Chromium while leaving this service alive, confirms
bounded concurrent recovery and one browser generation, and verifies that an
established persistent login survives relaunch and container replacement.
