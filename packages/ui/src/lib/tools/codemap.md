# packages/ui/src/lib/tools/

## Responsibility
Pure helpers for runtime tool metadata shared across host adapters.

## Design
- `manifest.ts` normalizes raw tool IDs, maps permission aliases such as edit/write/patch, and builds deterministic tool manifest payloads.

## Flow
Host runtime adapters fetch available tool IDs from their transport, call these helpers, and expose the result through `ToolsAPI.getToolManifest()`.

## Integration
Used by web runtime API adapters; the shared UI consumes the typed contract from `lib/api/types.ts`.
