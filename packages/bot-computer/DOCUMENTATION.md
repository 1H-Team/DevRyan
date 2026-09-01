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

The image installs a root-owned managed Chromium policy that enables JavaScript,
allows sites to persist local data and cookies, and allows third-party cookies.
The policy applies uniformly to agent commands and human-control sessions and
overrides stale content settings without rewriting `/data/chromium`. It does not
expose script evaluation or cookie-reading commands to the reasoning agent.

Chromium runs headed on a private Xvfb display (`1280×720`, 24-bit,
device-scale 1) with TCP listening disabled. The service verifies the exact
root-owned managed policy and waits for the X11 socket before its HTTP health
endpoint can succeed. An unexpected Xvfb exit makes health fail and closes the
browser; there is no headless fallback. Graceful service shutdown closes
Chromium before Xvfb so the persistent profile can flush first.

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
Chromium is stabilized at a 1280×720 viewport with device scale factor 1, and
screenshot/screencast metadata carries those verified dimensions.

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
commands are rejected before execution with `DEVRYAN_BOT_CONTROL_HELD` while
the lease is active; the host persists and resumes the exact action after
return or expiry. Return and natural expiry synchronously fence human input,
then release held keys and buttons before clearing the lease or waking agents.
The controller registers the exact live driver's cleanup with the lease manager.
Cleanup has a two-second deadline; failure returns
`DEVRYAN_BOT_CONTROL_RELEASE_FAILED`, keeps the agent fence in place, and permits
the same owner to retry Return Control. Human commands require that lease;
passive MJPEG viewing is a separate runtime-bearer capability and never grants
control or pauses the agent.

The human-only `input` command accepts at most 32 events and 64 KiB after exact
shape validation. Pointer events carry phase, bounded viewport coordinates,
button/mask, and click count; wheel events carry bounded deltas; key events
carry ordered phase/key/code/modifier/location/repeat data; text events carry
bounded Unicode insertion for paste and IME. Events are dispatched to CDP in
batch order, while pointer moves and wheel updates may be coalesced by the UI.
This command is not part of the reasoning agent's reviewed inventory. Audit
metadata records only event types, count, and duration—never text, keys,
modifiers, or coordinates.

The web runtime reuses an already-authorized active browser runtime without a
Docker inspection on every input batch; the periodic health sweep still performs
authoritative inspection and cleanup. The UI allows only one batch request in
flight, coalesces continuous hover/wheel backlog, and preserves pointer-down/up
and keyboard ordering. CDP dispatch completes before the route responds, while
content-free audit delivery is scheduled afterward so audit storage latency does
not delay the visible click or keystroke.

Pointer movement is coalesced only while no button is held. Real held-pointer
movement remains ordered, down/up events are never discarded under backlog
pressure. Explicit Return Control allows the UI queue at most 250 ms to drain;
Hide, unmount, and ownership changes abort the HTTP request and discard its queue.
The driver tracks held keys/buttons only in bounded ephemeral maps and sends
release events through the same ordered CDP socket, even if an earlier command's
acknowledgment is stalled. A generation fence cancels queued old batches and
ownership is rechecked before every event, so a late response cannot re-press a
released key. At most eight batches may queue at the driver boundary. No pointer
movement is synthesized and held-input details never enter status or diagnostics.

The driver enables only the CDP page/network lifecycle events needed for the
computer status diagnostic. Raw events are reduced immediately into a bounded,
memory-only record containing public origin, status, redirect/repetition
counts, standardized failure reason, and an optional normalized blocked host.
Paths, queries, headers, cookie names/values, page/console text, screenshots,
credentials, challenge payloads, coordinates, and typed input are never kept or
returned. Status also reports headed/headless-legacy mode, engine version,
display readiness, and managed JavaScript/cookie capability states.

Screencasting is subscriber-driven. Creating a viewer descriptor transmits no
pixels; attaching its one-use stream idempotently launches Chromium when an
Active Bot has not opened it yet. The first connected viewer starts one shared
CDP screencast, additional viewers share its in-memory fan-out, and the final
disconnect calls `Page.stopScreencast`. Every new viewer also receives one
fresh transient JPEG capture, so a viewer joining an unchanged page does not
wait for later page damage before it can render. Disconnect cleanup is installed
before asynchronous browser startup and releases a subscription even when the
client leaves during attachment. JPEG bytes are transient and are never retained
by this service.

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
established persistent login survives relaunch and container replacement. Its
isolated fixture egress also exercises real Chromium click, right/middle/double
click, hover, drag, wheel, printable keys, text insertion, navigation keys, and
modifier shortcuts through the human-only lease path.
