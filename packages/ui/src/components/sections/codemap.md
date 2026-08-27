# packages/ui/src/components/sections/

## Responsibility
Defines settings-domain feature sections (providers, agents, Bots, MCP, skills, plugins, projects, users/access, usage, behavior, commands, remote instances, etc.) with paired sidebar and page content components.

## Design
- **Section module pattern**: each section folder commonly exposes `*Sidebar` + `*Page` components consumed by `SettingsView`.
- **Shared settings scaffolding**: `shared/*` centralizes layout primitives (sidebar/header/layout/page wrappers) to keep section UIs consistent.
- **Metadata-driven navigation**: section availability and routing are coordinated through settings metadata (`lib/settings/metadata`) rather than hardcoded branching inside each section.
- **Managed quota credentials**: `providers/ManagedQuotaCredentials.tsx` is the shared, secret-non-prefilling editor for OpenCode Go, Ollama Cloud, and Cursor dashboard/OAuth quota credentials; it reuses the single quota refresh coordinator.
- **Shared-host administration**: `users/UserManagementPage.tsx` renders role-aware user/invite/activity review for senior developers and full user, project, branch, GitHub-account, policy, audit export/purge administration for admins.
- **Managed issue intake and diagnostics**: `bug-reports/BugReportsPage.tsx` provides permission-gated report submission plus lazily mounted administrator report/error review without adding broadly shared store state.
- **Production Bot management**: `bots/` provides a profile-first catalog and
  the simplified Overview, Resources, Memory, Members, Routines, and Lifecycle
  settings. The shared `components/bots/BotAvatar.tsx` consistently projects
  encrypted avatars, migrated glyphs, then initials. Overview owns name, title,
  avatar, and status without a short-summary or advanced-instruction layer.
  Resources combines capability-first defaults, the persistent Bot computer,
  desktop file/folder import with Finder reveal, optional on-demand Skills/SOPs,
  protected provider API keys/accounts, and concise write-only environment
  secrets. There is no Bot MCP, AG-UI, policy, file/browser permission, source
  library, revision, bundle, or recovery configuration surface.
  `BotMemoryConsole.tsx` and `BotMemoryEditor.tsx` present Remembered and
  Forgotten facts and refresh from authoritative memory events. Members exposes
  who may message and operate the Bot without role selection. Routines presents
  schedule, timezone, goal, rationale, timeout, and completion criteria while
  consequential actions use requester confirmation. Lifecycle presents Active,
  Paused, and exact-name Delete; internal retirement/purge mechanics remain
  partial-failure-safe but are not product concepts. `BotRuntimeServicePanel.tsx`
  still projects the Electron-owned background runtime status independently of
  the React component.
- **Global capabilities versus Bot SOPs**: Coding Agent Skills, MCP Servers, and
  plugins keep their existing Settings destinations. Bots do not have an MCP
  assignment workspace. An installed Skill can be added as an optional SOP from
  the Bot Resources tab and is materialized for OpenCode's on-demand Skill
  loading rather than ordinary prompt context.
- **Bot creation dialog**: `bots/BotsPage.tsx` uses the shared Dialog primitive;
  its server-authorized add control is one native button with direct dialog
  semantics and remains independent from catalog/detail request errors. The
  Electron Settings overlay and top-row controls are explicit no-drag regions.
  Successful creation closes the dialog, selects the new Bot, opens Overview,
  and focuses Name; request errors stay within the dialog.

## Flow
1. `SettingsView` resolves active settings slug.
2. Matching section sidebar/page components render based on runtime context and availability.
3. Section pages read/write feature stores (`useAgentsStore`, `useMcpConfigStore`, `useSkillsStore`, etc.) and call relevant APIs/helpers. Bot management uses `lib/botsApi.ts` directly so working-revision conflicts and lifecycle results remain request-scoped rather than entering the high-frequency Bot event stores.
4. UI state persists through corresponding store persistence or server-backed settings APIs.

## Integration
- Integrates with `stores/*` for configuration/state mutations.
- Uses `components/ui/*` controls and `lib/i18n` translation keys.
- Some sections integrate directly with backend routes via helpers (MCP OAuth, providers auth, skills catalog, quota/usage endpoints, `/api/admin/*` shared-host management, and managed bug/error routes).
