# Terminal Module Documentation

## Purpose
This module provides WebSocket transport utilities for terminal input and output in the web server runtime, including message normalization, control frame parsing, rate limiting, pathname resolution, short-lived output replay buffering, and the managed-project public environment boundary used by developer shells.

## Entrypoints and structure
- `packages/web/server/lib/terminal/`: Terminal module directory.
  - `index.js`: Stable module entrypoint that re-exports protocol helpers and replay-buffer helpers.
  - `runtime.js`: Runtime module that owns terminal session state, WS server setup, and `/api/terminal/*` route registration.
  - `project-environment.js`: Fixed-file dotenv parser/loader that admits browser-public values from a managed project's registered repository.
  - `terminal-ws-protocol.js`: Single-file module containing terminal WebSocket protocol utilities.
  - `output-replay-buffer.js`: Helper module for buffering recent terminal output so late subscribers can receive startup prompt data.
- `packages/web/server/lib/terminal/terminal-ws-protocol.test.js`: Test file for protocol utilities.
- `packages/web/server/lib/terminal/output-replay-buffer.test.js`: Test file for replay buffer helpers.

Public API entry point: imported by `packages/web/server/index.js` from `./lib/terminal/index.js`.

## Public exports

### Constants
- `TERMINAL_WS_PATH`: Primary WebSocket endpoint path (`/api/terminal/ws`).
- `TERMINAL_WS_CONTROL_TAG_JSON`: Control frame tag byte (`0x01`) indicating JSON payload.
- `TERMINAL_WS_MAX_PAYLOAD_BYTES`: Maximum inbound WebSocket payload size (64KB).
- `TERMINAL_OUTPUT_REPLAY_MAX_BYTES`: Maximum buffered terminal output retained for replay (64KB).

### Request Parsing
- `parseRequestPathname(requestUrl)`: Extracts pathname from request URL string. Returns empty string for invalid inputs.
- `isTerminalWsPathname(pathname)`: Returns whether a pathname matches a supported terminal WebSocket route.

### Message Normalization
- `normalizeTerminalWsMessageToBuffer(rawData)`: Normalizes various data types (Buffer, Uint8Array, ArrayBuffer, string, chunk arrays) to a single Buffer.
- `normalizeTerminalWsMessageToText(rawData)`: Normalizes data to UTF-8 text string.

### Control Frame Handling
- `readTerminalWsControlFrame(rawData)`: Parses WebSocket message as control frame. Returns parsed JSON object or null if invalid or malformed.
- `createTerminalWsControlFrame(payload)`: Creates a control frame with JSON payload and prepends the control tag byte.

### Replay Buffer Helpers
- `createTerminalOutputReplayBuffer()`: Creates mutable state for recent terminal output replay.
- `appendTerminalOutputReplayChunk(bufferState, data, maxBytes?)`: Appends a chunk, trimming older buffered data to stay within the configured byte budget.
- `listTerminalOutputReplayChunksSince(bufferState, lastSeenId)`: Returns buffered chunks newer than the provided replay cursor.
- `getLatestTerminalOutputReplayChunkId(bufferState)`: Returns the latest chunk id in the replay buffer, or `0` when empty.

### Rate Limiting
- `pruneRebindTimestamps(timestamps, now, windowMs)`: Filters timestamps to keep only those within the active time window.
- `isRebindRateLimited(timestamps, maxPerWindow)`: Checks if rebind operations have exceeded the configured threshold.

## Usage in web server
The terminal helpers are used by `packages/web/server/index.js` for:
- WebSocket endpoint path definition and matching
- Message normalization for terminal input payloads
- Control frame parsing for session binding, keepalive, and exit signaling
- Rate limiting for session rebind operations
- Request pathname parsing for WebSocket routing
- Replaying startup output such as shell prompts when the client binds after the PTY already emitted data

The web server combines these utilities with `bun-pty` or `node-pty` to drive full-duplex PTY sessions.

### Runtime lifecycle contract

`createTerminalRuntime(...)` returns `shutdown`, `terminateOwnerSessions`, `getSessionDescriptor`, and `touchSession`. The descriptor lookup exposes only the live session id, canonical working directory, owner user id, and last-activity timestamp to in-process server runtimes. `touchSession(sessionId, ownerUserId)` renews activity only when both identifiers match a live session. The project-preview grant registry uses these operations to prove that a registration came from a terminal owned by the caller in the exact project directory and to keep that terminal alive while its loopback app remains reachable. Ordinary idle shells and unreachable previews retain the existing idle-cleanup behavior.

Callers may provide `onTerminalSessionClosed`. The runtime invokes it exactly once after removing a session for exit, explicit close/restart, idle timeout, force kill, owner revocation, or shutdown. Session removal happens before signalling a PTY so synchronous exit callbacks cannot replace the authoritative close reason. Preview grants use this callback for immediate cleanup; their independent liveness sweep is a fallback and does not depend on an open Browser panel.

### Managed project public environment contract

Managed principals continue to receive the minimal host environment allowlist (`PATH`, user/home/shell/temp/locale/terminal fields). When the terminal working directory resolves to a project assigned to that principal, create and restart additionally read these files from the project's canonical registered repository, in increasing precedence order:

1. `.env`
2. `.env.local`
3. `.env.development`
4. `.env.development.local`

Only browser-public conventions are admitted: `VITE_`, `NEXT_PUBLIC_`, `PUBLIC_`, `REACT_APP_`, `GATSBY_`, `NUXT_PUBLIC_`, and `EXPO_PUBLIC_`, plus the compatibility keys `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_PUBLISHABLE_KEY`. Known server-credential shapes remain denied even if someone gives them a public prefix, including Supabase service-role/secret keys, private/secret/password/database keys, and common provider API credentials.

The loader resolves the registered root and every dotenv source through real paths, rejects symlink escapes, accepts only regular files, caps each source at 256 KiB, and does not include values in errors or response payloads. Missing files are normal. Non-managed local administrators retain the pre-existing host environment behavior and do not use this loader.

## Notes for contributors
- Keep control frames backward-compatible when possible; use explicit `v` values for protocol changes.
- Always normalize incoming WebSocket messages before processing them.
- Keep replay buffering small and memory-only; it exists to cover startup races, not to implement persistent scrollback.
- Add tests for new control frame types, websocket path changes, malformed payload handling, and replay trimming semantics.
- Keep HTTP input and SSE output fallbacks functional unless the rollout explicitly removes them.
- Keep terminal descriptors narrow and live-only; do not expose PTY handles or infer ownership from historical terminal output.
- Route every session removal through the lifecycle callback so dependent in-memory grants cannot survive terminal closure or revocation.
- Keep managed dotenv filenames fixed, preserve assignment checks, and never widen the public-key policy to admit server credentials.

## Verification notes
### Manual verification
1. Start the web server and create a terminal session via `/api/terminal/create`.
2. Wait briefly before binding the client to ensure the shell emits its prompt first.
3. Connect to `/api/terminal/ws` WebSocket and bind to the session.
4. Verify the startup prompt and early shell output are replayed before interactive input begins.
5. Verify `/api/terminal/input-ws` is rejected with `404 Not Found` and `/api/terminal/:sessionId/stream` still works as a fallback path.

### Automated verification
- Run `bun run --cwd packages/web test -- server/lib/terminal/project-environment.test.js server/lib/terminal/runtime.test.js`
- Run `bun run --cwd packages/web test -- server/lib/terminal/terminal-ws-protocol.test.js server/lib/terminal/output-replay-buffer.test.js`
- Run `bun run type-check`, `bun run lint`, and `bun run build` before finalizing changes.
