# docker/

## Responsibility

Build and fixed-compose definitions for the Electron-owned Production Bots
runtime. Docker resources are deployment infrastructure; Bot authorization and
domain state remain in the web server and `packages/bots-runtime`.

## Main paths

- `bots/compose.yml`: fixed `devryan-bots` supervisor, engine-proxy, egress, and indexer
  service topology. Electron supplies validated manifest image references and
  deployment-scoped runtime secrets. Only the engine proxy mounts the Docker
  socket. Named runtime/index volumes are intentionally preserved across
  repair, update, rollback, and app quit.

## Integration

- `packages/electron/bot-runtime-manager.mjs` is the sole compose lifecycle
  owner and invokes Docker with argv arrays rather than a shell.
- Runtime images and confinement policy are implemented by the Bot service
  packages; no renderer or web request may submit arbitrary Docker operations.
- The scoped OpenCode image lives under `packages/bots-runtime/docker/opencode`;
  the persistent Chromium image lives at `packages/bot-computer/Dockerfile`;
  the offline rebuildable retrieval image lives at `packages/bot-indexer/Dockerfile`.
- Dynamic reasoning containers join the internal `devryan-bots-reasoning`
  network and reach public model hosts only through egress. Dynamic computer
  containers join the internal `devryan-bots-computer` network and reach only
  the authenticated browser-egress relay; only egress joins the public-NAT
  network.
- Compose labels the management, reasoning, and computer networks with their
  reviewed policy roles so local inspection exposes the intended boundary.
- The indexer and supervisor join the internal management network plus a
  no-masquerade control bridge used only for ephemeral loopback-published host
  ports. This preserves Electron reachability without outbound NAT. Reasoning
  and computer containers never join that bridge and cannot reach the indexer.
