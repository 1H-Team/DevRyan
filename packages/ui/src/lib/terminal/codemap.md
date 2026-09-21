# packages/ui/src/lib/terminal/

## Responsibility
Houses terminal module code for the shared UI runtime.

## Design
Organized as small focused modules; public helpers stay thin and keep state outside this folder.

## Flow
Callers import folder modules, pass runtime/store context, receive transformed data or rendered UI fragments.

## Integration
Used by nearby UI surfaces under packages/ui/src and wired through app-level stores/hooks.

- `SerializeAddon.ts` consumes the vendored `../ghostty` buffer contract. It includes scrollback, skips wide-character continuation cells, joins soft wraps, preserves colors/cursor state and restores the viewport after a snapshot. Historical blocks in terminal transport/store queues carry replay provenance through remounts.
