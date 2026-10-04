# packages/web/bin/

- `runtime-bundle-command.js` dispatches the fully specified local
  `openchamber runtime bundle resume --expected-revision N` recovery operation.
  It uses the same original-proof, owner-exit, unchanged-candidate and revision
  checks in every output/TTY mode, without HTTP mutation or runtime bootstrap.

## Responsibility
Node CLI surface for launching and operating DevRyan/OpenChamber server features (serve lifecycle, tunnel workflows, status/log-style output).

## Design
- **Single-command orchestrator** in `cli.js` with shared output/prompt helpers from `cli-output.js`.
- **Policy-first validation**: hard checks for unsafe browser ports, managed origin ports (`1024–65535`), duration/TTL bounds, and runtime preconditions before prompt UX.
- **Dual-mode output**: human-friendly Clack UI in TTY and deterministic JSON/quiet modes for automation.
- **Local owner proof**: `enroll-owner` creates a two-minute filesystem challenge. `tunnel-owner-auth.js` authenticates subsequent CLI tunnel requests through that exchange without implicitly enrolling a host or saving cookies to disk. Bot links have a 15-minute lifetime and sessions last seven days.

## Flow
1. `cli.js` parses argv/env, resolves command mode, and selects output strategy.
2. Commands may start foreground server (`server/index.js`) or call local API endpoints.
3. Tunnel-related commands normalize user input and atomically persist schema-v2 profiles, including the fixed managed-remote `originPort` (default `3000`).
4. Command exit paths map to explicit exit-code constants.

## Integration
- Package `bin` entry (`openchamber`) points here.
- Imports tunnel capability metadata from `server/lib/tunnels/providers/cloudflare.js`.
- Uses the same verified native generation-2 server runtime as Electron/web deployment.
  Serve no longer probes PATH or requires a separately installed OpenCode CLI; the
  Help describes bundled runtime updates through DevRyan and exposes no external
  OpenCode connection or standalone launch environment controls. The
  server entrypoint provisions/binds the bundled native runtime and fails on absent
  or corrupt artifacts. CLI TTY/quiet/JSON validation and exit semantics are retained.
