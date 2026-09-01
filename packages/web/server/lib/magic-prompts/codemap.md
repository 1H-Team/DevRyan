# packages/web/server/lib/magic-prompts/

## Responsibility
Persistence/runtime for user magic-prompt overrides plus REST routes to read, set, and reset prompt text overrides.

## Design
- `runtime.js` encapsulates file-backed state (`version`, `overrides`) with strict ID/content validation.
- Serialized writes use an internal promise lock to prevent concurrent write races.
- `routes.js` maps runtime validation errors to stable HTTP status codes (400 vs 500).

## Flow
1. Route bootstrap constructs runtime with `openchamberDataDir/magic-prompts.json`.
2. GET returns current state; PUT validates `:id` and `text` then persists override.
3. DELETE `:id` removes one override; DELETE collection resets all overrides.

## Integration
- Mounted from server startup and consumed by UI settings/prompt editing surfaces and action execution.
- Stores only override deltas; base prompt catalog remains in upstream prompt definitions.
- The effective GET catalog is an authenticated runtime dependency inherited by all managed users. Settings-page visibility and every PUT/DELETE mutation remain controlled by the canonical Magic Prompts Read/Edit permission.
