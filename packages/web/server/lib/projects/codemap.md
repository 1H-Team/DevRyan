# packages/web/server/lib/projects/

## Responsibility
Project-level configuration domain, including scheduled task definitions, task
execution metadata, default-off evidence checkpoint settings, and stable project
ID derivation.

## Design
- **Schema-normalization approach** (`project-config.js`) validates and canonicalizes nested schedule/execution objects.
- **Defensive constraints**: max lengths, timezone validation (IANA), cron parsing, schedule kind guards.
- **Versioned config model** (`PROJECT_CONFIG_VERSION`) for forward-compatible persistence.
- **Lossless atomic writes** preserve unrelated/future keys while using the
  harness fsync/rename primitive.
- **Shared path identity** (`project-id.js`) derives both stable project IDs and the matching active-project plan directory under `~/.config/openchamber/projects`.

## Flow
1. Input payload is normalized (strings, enums, dates/times, weekdays, cron, execution parameters).
2. Invalid fields throw explicit errors with deterministic messages.
3. Valid config is serialized/persisted and used by scheduled-tasks runtime.
4. Project IDs (`project-id.js`) bind config records and canonical plan storage to workspace directories.

## Integration
- Consumed by scheduled-tasks routes/runtime and server project settings endpoints.
- Depends on `luxon` + `cron-parser` for timezone/cron correctness.
- Cooperates with OpenCode directory resolution to scope per-project config files and managed agent access to the active project's plans.
