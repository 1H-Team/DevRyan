# packages/web/server/lib/terminal/

## Responsibility
Terminal transport/runtime utilities for PTY streaming: WebSocket protocol normalization, control frames, rebind rate limiting, output replay buffering, and project-scoped public environment injection for managed developer shells.

## Design
- **Protocol-first design** (`terminal-ws-protocol.js`) defines payload constraints and frame parsing/encoding.
- **Replay buffer primitive** (`output-replay-buffer.js`) supports terminal reattach/resume without full process restart.
- **Public environment boundary** (`project-environment.js`) reads only fixed development dotenv files from the assigned project's registered repository, applies deterministic precedence, and rejects server credentials before values reach a managed PTY.
- **Runtime wrapper** (`runtime.js`) composes protocol + PTY IO hooks.

## Flow
1. Incoming WS frames are normalized to text/buffer and checked for control tags.
2. Managed terminal create/restart resolves the owning registered project and merges its browser-public dotenv values into the existing minimal shell environment.
3. Runtime forwards valid input to active PTY channel.
4. PTY output chunks are appended to replay buffer with chunk IDs.
5. Rebinding clients request chunks since last ID to recover missed output.

## Integration
- Used by `/api/terminal/*` routes in server runtime.
- Consumed by `src/api/terminal.ts` adapter + shared terminal UI (`ghostty-web`).
- Coordinates with event-stream/websocket lifecycle in server bootstrap.
- Uses the multi-user project's canonical registered repository only as the source for ignored public dotenv values; the developer's active worktree remains the PTY working directory.
