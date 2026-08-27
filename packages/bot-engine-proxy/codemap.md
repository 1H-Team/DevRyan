# packages/bot-engine-proxy

- `src/server.js`: authenticated eleven-verb internal HTTP boundary and the
  sole Docker-socket process.
- `Dockerfile`: non-root, read-only runtime image; Compose supplies the socket
  group and mounts the socket.
- Docker domain validation remains centralized in
  `packages/bot-supervisor/src/docker.js` and is copied into the signed image.
