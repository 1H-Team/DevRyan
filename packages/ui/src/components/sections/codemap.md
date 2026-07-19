# packages/ui/src/components/sections/

## Responsibility
Defines settings-domain feature sections (providers, agents, MCP, skills, plugins, projects, usage, behavior, commands, remote instances, etc.) with paired sidebar and page content components.

## Design
- **Section module pattern**: each section folder commonly exposes `*Sidebar` + `*Page` components consumed by `SettingsView`.
- **Shared settings scaffolding**: `shared/*` centralizes layout primitives (sidebar/header/layout/page wrappers) to keep section UIs consistent.
- **Metadata-driven navigation**: section availability and routing are coordinated through settings metadata (`lib/settings/metadata`) rather than hardcoded branching inside each section.
- **Managed quota credentials**: `providers/ManagedQuotaCredentials.tsx` is the shared, secret-non-prefilling editor for OpenCode Go, Ollama Cloud, and Cursor dashboard/OAuth quota credentials; it reuses the single quota refresh coordinator.

## Flow
1. `SettingsView` resolves active settings slug.
2. Matching section sidebar/page components render based on runtime context and availability.
3. Section pages read/write feature stores (`useAgentsStore`, `useMcpConfigStore`, `useSkillsStore`, etc.) and call relevant APIs/helpers.
4. UI state persists through corresponding store persistence or server-backed settings APIs.

## Integration
- Integrates with `stores/*` for configuration/state mutations.
- Uses `components/ui/*` controls and `lib/i18n` translation keys.
- Some sections integrate directly with backend routes via helpers (MCP OAuth, providers auth, skills catalog, quota/usage endpoints).
