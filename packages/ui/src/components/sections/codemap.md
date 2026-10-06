# packages/ui/src/components/sections/

## Responsibility
Defines settings-domain feature sections (providers, agents, Bots, MCP, skills, plugins, projects, users/access, usage, behavior, commands, remote instances, etc.) with paired sidebar and page content components.

## Design
- **Section module pattern**: each section folder commonly exposes `*Sidebar` + `*Page` components consumed by `SettingsFrame`.
- **Shared settings scaffolding**: `shared/*` centralizes layout primitives (sidebar/header/layout/page wrappers) to keep section UIs consistent.
- **Metadata-driven navigation**: section availability and routing are coordinated through settings metadata (`lib/settings/metadata`) rather than hardcoded branching inside each section.
- **Agents destination**: Settings → Agents combines session defaults and agent
  configuration without tabs. The `agents/` sidebar pins Session Defaults (the
  separately permissioned `sessions` page), Behavior and host-only Runtime above
  the agent lists; see `agents/codemap.md`.
- **Managed quota credentials**: `providers/ManagedQuotaCredentials.tsx` is the shared, secret-non-prefilling editor for OpenCode Zen, Ollama Cloud, and Cursor dashboard/OAuth quota credentials; it reuses the single quota refresh coordinator.
- **Cursor platform availability**: `providers/ProvidersPage.tsx` projects the
  typed runtime capability before authentication status. Windows ARM64 keeps
  saved settings but disables setup and never displays a saved key as a working
  SDK connection. Pending disconnect status retains precedence.
- **Shared-host administration**: `users/UserManagementPage.tsx` renders role-aware user/invite/activity review for senior developers and full user, project, branch, GitHub-account, policy, audit export/purge administration for admins. Checked persisted branches expose a separate write-only preview URL/service-token editor with connection testing, rotation, and removal.
- **Managed issue intake and diagnostics**: `bug-reports/BugReportsPage.tsx` provides permission-gated report submission plus lazily mounted administrator report/error review without adding broadly shared store state.
- **Production Bot management**: `BotsPage` uses the shared catalog retry controller
  for transient startup recovery and isolates management state by principal.
  Its loading, blocked and failed states come from `resolveBotCatalogReadiness`,
  never from a flag that only a gated request could clear.
  `BotCatalogPanel` polls pending hosted discovery independently of local reads
  and offers the owner's explicit hosted check (`canCheckHostedBots`) in the
  full variant only.
  `bots/` provides a profile-first catalog and
  the simplified Overview, Resources, Memory, Members, Routines, and Lifecycle
  settings. The shared `components/bots/BotAvatar.tsx` consistently projects
  encrypted avatars, migrated glyphs, then initials. Overview owns name, title,
  avatar, Soul/personality, Standing Role, Objectives, primary Provider/Model/Thinking, and status without a
  short-summary or advanced-instruction layer. Core identity changes remain
  revision-backed and apply only to future runs.
  `BotTelegramConnection.tsx` independently saves each Bot's native Telegram
  configuration and each member's one-use pairing/routine/voice preferences.
  `BotSpeechSettings.tsx` separately saves host-owned encrypted speech settings
  and checks provider readiness; neither editor receives existing credentials.
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
  is the page's Global Settings section: the administrator-only Background
  Runtime Service switch plus the Electron-owned runtime status, projected
  independently of the Bot editor. `BotCatalogPanel.tsx` is the Bot Storage section
  (and, in compact form, the recovery view that replaces the Bot chat): one
  recovery control per catalog state from `botCatalogPresentation.ts` —
  Restore the latest verified backup or Start Empty (typed confirmation),
  Resume Bots after the activation hold, Resume/Cancel/Dismiss a hosted import,
  or Import Bots with an explicit other-writers-stopped confirmation — plus
  Back Up Now and the verified backup list for the owner. Non-owners see
  status only.
- **Global capabilities versus Bot SOPs**: Coding Agent Skills, MCP Servers, and
  plugins share the Plugins hub at the top of Connections, one tab each, with
  their own permission slugs. Bots do not have an MCP
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
1. `SettingsFrame` resolves active settings slug.
2. Matching section sidebar/page components render based on runtime context and availability.
3. Section pages read/write feature stores (`useAgentsStore`, `useMcpConfigStore`, `useSkillsStore`, etc.) and call relevant APIs/helpers. Bot management uses `lib/botsApi.ts` directly so working-revision conflicts and lifecycle results remain request-scoped rather than entering the high-frequency Bot event stores.
4. UI state persists through corresponding store persistence or server-backed settings APIs.

## Integration
- Integrates with `stores/*` for configuration/state mutations.
- Uses `components/ui/*` controls and `lib/i18n` translation keys.
- Some sections integrate directly with backend routes via helpers (MCP OAuth, providers auth, skills catalog, quota/usage endpoints, `/api/admin/*` shared-host management, and managed bug/error routes).

- `bots/BotMemoryExtractionDetails.tsx`: cursor-paged, content-free extraction
  activity with per-job retries and event/poll refresh of all loaded pages.
