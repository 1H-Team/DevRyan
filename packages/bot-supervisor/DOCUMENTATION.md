# Restricted Production Bots Docker supervisor

The deployment and incident runbook is `docs/BOTS_RUNTIME.md`. This module
document defines the narrower Docker-socket and fixed-command contract.

The supervisor converts eleven authenticated domain operations into a fixed set
of versioned requests to `bot-engine-proxy`. It has no Docker socket and is not a
Docker proxy. Callers cannot choose Engine routes, API versions, images, mounts,
networks, environment names, published interfaces, or resource limits.

## Authentication and command surface

Management requests require the deployment-scoped
`DEVRYAN_BOT_SUPERVISOR_TOKEN` as an HTTP bearer token. The only routes are:

- `POST /v1/ensure/reasoning`
- `POST /v1/ensure/computer`
- `POST /v1/status`
- `POST /v1/stop`
- `POST /v1/reset`
- `POST /v1/workspace/write`
- `POST /v1/workspace/list`
- `POST /v1/workspace/export-image`
- `POST /v1/filesystem/list`
- `POST /v1/shared/import`
- `GET /v1/owned`

`GET /healthz` discloses only service liveness. Request bodies are strict JSON;
unknown fields, query widening, duplicate authentication headers, and
unreviewed paths fail closed.

`workspace/write` accepts only an owned reasoning identity, a single bounded
top-level filename, and at most 48 KiB of content. The supervisor rejects
links, special files, reserved runtime directories, and traversal, then writes
a fixed ustar archive through Docker Engine's container archive endpoint. The
caller cannot select a volume, container, archive path, ownership, or mode.

`workspace/list` is the read-only counterpart and backs the Files tab. It takes
an owned reasoning or computer identity and an optional relative subdirectory,
and returns one directory level: name, type, size, and modification time. Docker
Engine has no directory-listing verb, so the supervisor streams the container
archive and keeps only the tar headers, discarding file bodies as they pass —
listing a large workspace costs no more than listing an empty one. Absolute
paths, traversal, over-deep paths, and the read-only `.devryan` / `.opencode`
mounts are rejected; symlinked entries are never presented as real files;
listings are capped at 500 entries and report `truncated`. An owned stopped
container remains readable through Docker's archive API and returns
`state: stopped`; listing never starts it. A missing container remains
`bot_supervisor_workspace_unavailable`.

`filesystem/list` is a separate, computer-only administrator operation. Its
root is fixed at `/`; callers still submit only a relative path and cannot
select a container or widen a workspace operation. It exposes one directory
level with `file`, `directory`, `symlink`, or `special` kinds and marks links,
special files, credential-bearing mounts, and virtual filesystems Restricted.
The owned computer must be running. The supervisor executes one fixed,
non-shell Node command as UID/GID 10001 that uses `opendir` and `lstat` only;
the caller controls only the validated directory argument. It therefore never
recursively walks `/`, reads file bodies, or exposes a generic exec surface.
Restricted roots include `/data/chromium`, `/data/opencode`, `/runtime-config`,
the two private workspace mounts, `/proc`, `/sys`, `/dev`, and `/run/secrets`.
They remain visible at their parent but cannot be traversed. Both listing verbs
require a real directory, never follow a symlink, and cap results at 500
entries. The container view accepts at most 32 levels and 1,024 UTF-8 path
bytes.

`workspace/export-image` is the only automatic generated-image export. Before
reasoning teardown it accepts one relative path in the owned reasoning
workspace, canonicalizes it beneath `/workspace`, rejects links, hard links,
special files, linked ancestors, and non-owned paths, and verifies archive
UID/GID 10001 plus a regular PNG/JPEG/GIF/WebP of at most 10 MiB by magic bytes.
It returns bounded bytes to Electron for the
server-owned encrypted-object publication path; it cannot export arbitrary tool
output or computer files.

`shared/import` is the only write path into the Bot-wide Shared volume. It
accepts an owned Bot identity, UUID channel/message segments, one traversal-safe
filename, expected size/hash, and at most 25 MiB of base64 content. The
supervisor derives `/workspace/Shared/<channel>/<message>/<filename>`, writes a
fixed same-directory staging archive into the owned computer, streams it back
for size/hash verification, commits it with one fixed atomic rename, and
re-verifies the final file before reporting readiness. Callers cannot select a
host path, container, volume, archive path,
ownership, or mode.

Runtime data-plane traffic uses a separate
`/v1/runtime/<256-bit-capability>/<runtime-path>` tunnel, which carries both
kinds because neither publishes a host port. The capability is created in memory
only after an authenticated ensure/status response, is bound to that
deterministic owned container, rotates when the container is replaced, and is
revoked by stop/reset. It is not a ninth Docker-management verb. The tunnel
accepts only ordinary HTTP methods, caps bodies at 4 MiB, allowlists request
headers, strips cookies and forwarding headers in both directions, and targets
only the fixed runtime port of an owned container.

The allowlist differs by kind, because the two runtimes authenticate
differently. OpenCode has no authentication of its own, so the scoped capability
is the whole authority and no caller credential reaches a reasoning container.
The computer authenticates every call itself, so its bearer capability and its
gateway-token header are the only extra headers that cross. The upstream
inactivity bound is dropped once a response starts streaming: a screencast of an
idle page sends no frames for minutes, and the caller's abort signal still ends
it.

## Engine-proxy and Docker socket boundary

Only `bot-engine-proxy` mounts `/var/run/docker.sock`. The supervisor reaches it
over the internal management network with a purpose-derived bearer and protocol
version. The proxy accepts only the eleven reviewed, version-normalized
method/path operations required by this module; validates exact bodies, query
parameters, ownership labels, image digests, network/volume scope, and bounded
responses; and rejects upgrades, unknown Docker API versions, encoded-path
tricks, arbitrary exec/create options, and unowned resources. If the proxy is
unavailable, lifecycle mutation fails closed.

A Docker socket remains root-equivalent. Splitting the supervisor from the
socket adds an independently authenticated and schema-constrained boundary, but
compromise of the engine-proxy container must still be treated as compromise of
the local Docker host. It runs non-root with no-new-privileges, all capabilities
dropped, a read-only root filesystem, bounded resources, and strict request
parsing. Docker Desktop for macOS virtualizes the socket group as 0; native Linux
uses the installation-resolved socket group only inside this proxy.

## Ownership and persistence

Container and volume names use a SHA-256 digest of deployment, Bot, runtime
kind, and canonical scope. Every resource carries deployment, Bot, scope, kind,
and image/volume-role labels. A same-name resource with mismatched labels is
refused. Updating an image stops and removes the owned container, then recreates
it against the same named volumes. `stop` retains all data. `reset` accepts only
the reviewed per-kind volume roles or `all` and deletes no other resource.

Every ensure capability binds run, channel, revision, and bearer token. Labels
contain capability hashes rather than bearer contents. Reasoning capability
rotation and revision, isolation-tier, runtime, or image changes recreate the
service. Browser-egress capability rotation is delivered live through the
computer's host-authenticated control route and does not replace Chromium; a
failed live rotation stops the computer instead of retaining stale authority.
Reasoning scope must exactly equal
`channel:<channelId>`; Team and personalized computer scope formats are
validated against the Bot and mode.

Before a new reasoning service starts, Electron validates the host-compiled
channel/revision/hash config and one-provider auth file with no-follow file opens,
private permissions, and exact revision/hash identity. The supervisor receives
only those derived identities and mounts the verified config read-only at
`/runtime-config`; it mounts only the per-run `auth.json` file at OpenCode's auth
path, leaving the named OpenCode data volume writable and visible. The isolated
file remains writable so OpenCode can refresh OAuth credentials before the host
re-seals them. Neither path is caller-selectable.

Bot-wide environment secrets use a third fixed per-run file. Electron verifies
the host-derived `environment.json` identity, count, private ownership, `0400`
mode, name limits, and reserved-variable rules; the supervisor mounts only that
file read-only at `/runtime-secrets/environment.json`. The OpenCode launcher
parses the JSON directly into `process.env` without shell evaluation. Computer
containers never receive this mount.

Electron also validates the fixed per-run artifact staging directory
recursively: the bounded manifest must match private regular files, and links,
special files, hard links, `.git`, and path escapes are refused. The supervisor
derives that path from the validated run ID and fixed runtime root, then mounts
it read-only at `/workspace/.devryan`. Requests cannot supply an artifact host
path or broaden the mount.

The compiled config directory always contains a private `skills` directory.
The supervisor derives it from the same fixed channel/revision/hash path and
mounts it read-only at `/workspace/.opencode/skills`. Equal compiled hashes in
different revisions remain isolated. Skill files are immutable snapshots.
Autonomous revisions may expose the reviewed `bash`, `terminal`, `git`, and
non-recursive `task` tools inside the confined reasoning container; those tools
cannot reach Docker, host paths, raw browser/CDP, direct MCP, or host
credentials.

The reasoning ensure request also carries an Electron-signed, short-lived
model-egress token. The supervisor validates its wire shape and places it only
in standard proxy URL credentials (`devryan:<token>`), so normal proxy clients
emit authenticated `Proxy-Authorization` without mixing it with upstream model
`Authorization`. Labels contain no egress or gateway bearer value.
The private gateway answers on the egress service's own in-network address and
is explicitly exempted through `NO_PROXY`; otherwise ordinary proxy resolution
would incorrectly send local Library, Memory, artifact, and approval calls to
model egress instead of to the gateway relay.

## Confinement

Both runtime kinds run as UID/GID 10001 with no-new-privileges, all capabilities
dropped, PID/memory/CPU limits, a read-only root filesystem, and bounded tmpfs.

Neither kind joins a network that is not internal, and neither publishes a host
port. That is one property, not two: Docker refuses to publish a host port for a
container attached only to internal networks, so a published port would have
required a bridge, and on Docker Desktop a container holding a bridge can open
direct outbound connections whether or not the bridge masquerades. Both
directions therefore run through services that already straddle the boundary.
Inbound, the supervisor shares both internal networks and hands the host one
revocable scoped path per container. Outbound, authenticated private-gateway
calls go to the egress service, which relays them to the host loopback address
Electron published on its control channel; a container cannot supply or discover
that address. No `host.docker.internal` mapping is left in either container.

The supervisor holds no verb that attaches a container to a network, so an
internal-only runtime cannot be widened after it is created.

Reasoning and computer networks are internal; only bot-egress joins the
public-NAT network. Reasoning receives the fixed model proxy, while computer
Chromium receives a loopback authenticated relay to the same service with a
browser-purpose token. Neither runtime may fall back to direct public egress.
Chromium receives exactly 1 GiB of shared memory. Callers cannot select another
proxy.

Computer creation accepts only `standard` or `runsc`. A `runsc` request reaches
Docker as `HostConfig.Runtime=runsc` only after Electron has verified Docker's
declared runtime list and passed an owned disposable smoke container. Failure is
visible and never rewritten to `standard`; replacement retains the persistent
profile volume.

The computer environment receives one Bot-scoped service bearer for the current
DevRyan process, the private gateway URL, and tenancy mode. Run, channel, and
revision changes do not replace the computer or clear `/workspace`; transfer
commands carry their short-lived run/channel gateway capability separately.
Both runtime kinds mount the same deterministic Bot-wide named volume read/write
at `/workspace/Shared`. It survives container replacement, repair, ordinary
restart, and scoped workspace resets; only an explicit Shared/all reset or Bot
purge removes it.

Run tests with `bun test packages/bot-supervisor`. Docker-backed tests remain
opt-in through `DEVRYAN_RUN_DOCKER_TESTS=1`.
