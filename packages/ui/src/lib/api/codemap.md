# packages/ui/src/lib/api/

## Responsibility
Generic API client helpers for UI-to-server HTTP interactions.

## Design
Fetch wrapper pattern with typed payload parsing and error normalization.
Runtime API contracts in `types.ts` define host-injected capabilities, including `ToolsAPI.getAvailableTools()` and the normalized `getToolManifest()` metadata contract.

## Flow
Feature modules call endpoint helpers; responses are mapped into store-ready models.

## Integration
Used by settings sections, auth, providers, skills, and session operations.

`SupabaseConnectionAPI` is an optional host capability for the local-owner About
switch. Its typed status separates desired mode, effective mode and restart
blockers. The web adapter lives in `packages/web/src/api/supabaseConnection.ts`;
Electron consumes the same HTTP capability.
