# Production Bots engine proxy

This container is the only Production Bots service that mounts
`/var/run/docker.sock`. It accepts the supervisor's eleven version-1 domain
operations over the internal management network and executes them through the
strict ownership, image, network, volume, and request validators of the Bot
Docker module it owns: `src/docker.js` with `names.js`, `workspace-archive.js`,
`workspace-listing.js` and the shared-file and generated-image verifiers. The
operation list, resource limits and error class come from the supervisor's
dependency-free `contract.js`, which the image copies as its only supervisor
file (`/app/packages/bot-supervisor/src/contract.js`).

The interface has no generic Docker route. It rejects unknown methods and
paths, queries, encoded paths, HTTP upgrades, transfer encoding, missing or
duplicate authentication/version headers, oversized bodies, and unknown JSON
fields. Docker Engine requests use the fixed `v1.44` API adapter and bounded
responses. Resource mutations still require exact deployment/Bot/scope labels;
container creation still uses only configured image references, networks,
mounts, resource limits, and optional `runsc` runtime.

The ordinary supervisor has no socket mount and can reach this service only on
the internal management network with a purpose-derived deployment token.
Failure of this proxy disables computer/reasoning lifecycle changes; it never
falls back to direct socket access.

Run `bun run --cwd packages/bot-engine-proxy test` for its HTTP boundary and Docker module tests.
