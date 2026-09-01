# Session title reliability audit — 2026-08-28

## Scope

- Shared web runtime used by standalone web, Electron, and responsive/mobile layouts.
- Provider models: `openai/gpt-5.6-sol`, `anthropic/claude-sonnet-4-5-20250929`, and `xai/grok-4.6`.
- Builder and Orchestrator agents, with Plan mode both off and on.
- VS Code was explicitly excluded because its extension-host title runtime is separate from these surfaces.

## Results

- Standalone web: 36/36 sessions passed across three consecutive complete provider/agent/Plan matrices.
- Electron: 36/36 sessions passed across three consecutive complete provider/agent/Plan matrices.
- Responsive mobile (390 × 844): the end-to-end smoke title appeared in the sidebar while the session was active, survived reload, and matched the authoritative session record.
- Every web/Electron placeholder was replaced within the 15-second target. The slowest recorded web title took 9,491 ms.
- Stored titles matched the projected sidebar title after authoritative idle, including the pending-reload and runtime-restart cells.
- No generated title included Plan, Builder, Orchestrator, or provider metadata.

## Restart and stale-state coverage

- Pending renderer reload preserved the projected title.
- Runtime restart recovered the durable outbox entry and completed persistence.
- Automated tests cover stale placeholder snapshots, manual-rename precedence, failed reads/PATCHes, corruption recovery, directory isolation, duplicate scheduling, deletion, and more than 20 historical placeholders.

The screenshots in this directory are sanitized visual evidence. `failure-web-runtime-restart-premature-404.png` records an early harness attempt that restarted before the managed runtime was ready; it was excluded and the completed restart cell is shown in `web-pass3-runtime-restart-recovered.png`.
