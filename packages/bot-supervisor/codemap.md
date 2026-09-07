# packages/bot-supervisor/

## Responsibility

Private, bearer-authenticated Docker lifecycle service for Production Bots. It
owns deterministic resource naming, deployment ownership checks, constrained
dynamic container specs, named-volume lifecycle, and the eleven reviewed
management operations. It has no Docker Engine socket; the independently
authenticated `bot-engine-proxy` is the sole socket process.

## Entry points

- `src/server.js`: authenticated HTTP surface for `ensure reasoning`, `ensure
  computer`, `status`, `stop`, `reset`, bounded `workspace write`, workspace and
  administrator container listings, secure workspace-image export, fixed Shared
  import, and `list owned`, plus the in-memory,
  capability-scoped reasoning data-plane tunnel.
- `src/docker.js`: fixed Docker Engine adapter, bounded graceful stops, and
  lifecycle implementation with an unresolved-stop fence before ensure.
- `src/engine-proxy-client.js`: exact internal protocol/version/auth client for
  the sole-socket engine proxy; no direct fallback exists.
- `src/workspace-archive.js`: strict single-file ustar encoder used by the
  owned reasoning-workspace write and Shared import operations.
- `src/shared-file-verifier.js`: streaming archive verifier that accepts only
  the expected regular file and checks its exact size and SHA-256 digest.
- `src/generated-image-verifier.js`: bounded PNG/JPEG/GIF/WebP magic-byte,
  size, and digest validation for automatic result publication.
- `src/workspace-listing.js`: tar-header-only workspace listing, scope-specific
  path normalization, generated-image path validation, entry limits, and the
  administrator Restricted-path policy. Administrator container listing uses
  the fixed `opendir`/`lstat` command in `src/docker.js`, so browsing `/` never
  recursively archives the image.
- `src/names.js`: opaque deterministic names and ownership/volume labels.
- `src/auth.js`: timing-safe bearer authentication.
- `Dockerfile`: non-root production image.

## Invariants

1. No request can submit an Engine path, HTTP method, image reference, bind
   mount, environment key, network, port, or resource limit.
2. A deterministic-name collision with labels outside the active deployment is
   refused, never adopted or deleted.
3. Image replacement removes only the owned container. Named volumes survive.
4. Neither kind joins a non-internal network or publishes a host port; Docker
   will not publish one for an internal-only container, and a bridge added to
   get one back would also hand the container a route to the host and the
   public internet. Both are reached through the supervisor's scoped runtime
   proxy, and both reach the private gateway through the bot-egress relay.
   `createBotDockerSupervisor` holds no network-attach verb at all.
5. Computer containers receive only a browser-purpose proxy token/relay; direct
   public egress is unavailable.
6. Run/channel/revision/reasoning-capability rotation replaces a dynamic
   container while preserving its scope-owned volumes; a computer also rotates
   when the in-network gateway address it was created for changes, which no
   longer moves when DevRyan restarts. Browser-egress
   capability rotation is applied live through the computer control route and
   never restarts the persistent profile; failure stops the computer.
7. Reasoning config is compiled by the server, no-follow verified by Electron,
   and mounted read-only from the fixed host runtime root; scoped auth is a
   separate per-run mount.
8. A reasoning container receives only an Electron-signed short-lived egress
   capability in fixed proxy credentials; no token is copied into labels, and
   the in-network gateway relay remains an explicit `NO_PROXY` route.
9. Per-run artifacts are derived from the fixed runtime root after recursive
   Electron validation and mounted read-only at `/workspace/.devryan`; callers
   cannot submit a host artifact path.
10. Revision-pinned skill packages are materialized below the fixed compiled
    config directory and mounted read-only at `/workspace/.opencode/skills`;
    the writable workspace cannot replace the nested mount.
11. The supervisor returns only an in-memory 256-bit reasoning capability;
    Electron converts it to the loopback supervisor path consumed by the
    in-process server. Replacement rotates it, stop/reset revoke it, and the
    renderer never receives it.
12. Workspace writes resolve only the owned reasoning container and accept one
    safe top-level regular file. Docker archive bytes use fixed private mode and
    runtime UID/GID; links, traversal, and reserved mount names are rejected.
13. Workspace listings retain the same path and link defenses for running and
    stopped owned containers and report state without starting them.
    Administrator container-root browsing requires a running computer because
    it uses a fixed in-container metadata command rather than recursive export.
14. One Bot-wide `shared` volume is mounted at `/workspace/Shared` in its
    computer and reasoning containers. Imports derive the UUID-scoped path,
    accept no host/container path, and become ready only after staged
    verification, atomic rename, and final size/hash verification; the volume
    survives replacement and ordinary resets.
15. Administrator computer browsing is a separate fixed verb rooted at `/`;
    Manager browsing remains rooted at `/workspace`. Links, special files, and
    credential/virtual roots are visible only as Restricted metadata.
16. Generated images leave a reasoning container only through the fixed
    canonical regular-file export and PNG/JPEG/GIF/WebP verifier before stop.
17. Per-run environment JSON is a host-derived read-only reasoning mount and is
    never present in the persistent computer container.
18. `runsc` creation is explicit in `HostConfig.Runtime`; unavailability fails
    without standard-tier downgrade and persistent profile volumes survive
    tier replacement.

See `DOCUMENTATION.md` for the socket threat boundary and operations contract.
