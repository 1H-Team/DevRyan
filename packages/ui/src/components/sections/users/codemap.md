# packages/ui/src/components/sections/users/

## Responsibility

Role-aware shared-host user and access administration inside Settings.

## Design

- `UserManagementPage.tsx` is a slim container: users table → per-user detail
  page (in-page `selectedUserId` drill-down with a Back button), plus the
  one-time temporary-password / invite-URL banners. In local web/Electron mode
  it renders the standalone GitHub account controls instead of requesting the
  managed-only `/api/admin/*` datasets.
- `useAdminUsersData.ts` owns all fetching with per-domain reloaders
  (`reloadUsers`, `reloadInvites`, `reloadActivity`, `reloadProjects`,
  `reloadRoles`, `reloadGithubAccounts`, `reloadAll`) so mutations refresh only
  what changed.
- `UsersTable.tsx` lists users (row click opens detail; admin-only) with the
  Create User button; `CreateUserDialog.tsx` creates accounts — non-admin roles
  require an initial project and branch, while admins may omit them.
- `ResetPasswordDialog.tsx` lets an administrator either set and confirm a new
  password or generate a one-time temporary password; either path revokes the
  target user's active sessions through the same server reset contract.
- `UserDetail.tsx` owns the accessible Core Details / Policy Overrides /
  Analytics tab shell. Panels remain mounted so profile, branch, permission,
  capability, and advanced-JSON drafts survive tab changes. Core contains
  Profile and Projects & Branches; access-link management remains on the User
  Management overview. Policy uses independent collapsibles with explicit
  `Inherit (On|Off)` effective values.
- `RolePoliciesSection.tsx` exposes Browser alongside the other core role
  capabilities. `UserDetail.tsx` derives the matching tri-state Browser
  override from the shared capability list, so absent values inherit the role.
- Agent Overrides includes `Hide Global Agent Behavior` beside the permission
  controls. Developers inherit hidden Behavior; senior developers and
  administrators inherit visible Behavior. The stored override is sparse, so
  an explicit `false` is retained when it is the developer's deviation from
  the role default.
- Source Overrides includes `Hide Update Tab`, a sparse per-user visibility
  override that removes Update from Source in the right sidebar without changing
  the user's underlying Git authorization.
- Core Capability Overrides also exposes `Create branches`. Developers inherit
  Off, senior developers inherit On, and a sparse per-user override can change
  the effective value without changing the role template.
- `Create worktrees` independently controls user-triggered worktree flows.
  Developers inherit Off, senior developers inherit On, and automatic
  assigned-branch target preparation remains available regardless of this UI
  capability.
- A standalone `Allow Bots Access` inherited toggle appears immediately before
  Core Capability Overrides. It stores the sparse `bots` capability without
  contributing to the core grid/count; disabling it makes every shared product
  audience surface Agents-only and removes Bot settings destinations.
- `UserAnalytics.tsx` lazily loads administrator-only ranged analytics for one
  user/time zone. Its full-range graph selects at most one day, while separate
  day-scoped event requests drive the totals, work blocks, prompts, and safe
  change/interaction detail. Prompts are grouped under initially collapsed
  durable session IDs; pagination merges into the existing groups. An
  administrator can clear the selected human user's complete current analytics
  snapshot through a confirmed server mutation; only the administrative purge
  marker remains in the separate audit view.
  `userAnalyticsPresentation.ts` formats immutable send-time model identifiers,
  including legacy missing-data fallbacks. Senior developers retain the
  sanitized audit list.
- `GitHubAccountsSection.tsx` sits directly below Users for administrators. It
  lists the token-free host account inventory, shows the exclusive profile
  owner, atomically reassigns credentials to visible humans or the signed-in
  administrator, reuses the shared OAuth device flow, and disconnects only
  unassigned credentials. A hidden agent-test owner is shown only as the
  current value so an administrator can move away from it without exposing
  other fixtures as targets.
- `openchamber/GitHubSettings.tsx` is mounted here for local administrators so
  connect, switch, disconnect, and `gh` CLI fallback controls share the User
  Management destination used by managed account assignment.
- `SettingsPermissionMatrix.tsx` renders the shared category-grouped Read/Edit
  ledger: binary role cells and tri-state inherited/On/Off user cells. Both
  matrices normalize untrusted or version-skewed responses to the complete UI
  catalog and render missing or malformed cells as denied instead of throwing.
- `ProjectsSection.tsx` (register/unregister-project dialog), `RolePoliciesSection.tsx`,
  `AccessLinksSection.tsx` (`AccessLinksList` reused by detail),
  `ActivitySection.tsx` (`ActivityList` reused by detail), and
  `ConfirmActionDialog.tsx` (replaces `window.confirm`) complete the overview.
- Senior developers can review non-admin users and their activity and manage
  targeted access links; mutation controls for accounts, assignments, policies,
  passwords, export, and purge are rendered only for administrators.
- Project paths remain administrator-only inputs. Assignment controls expose
  project labels, branch-visibility filters, and one default branch. They do
  not choose GitHub credentials; branch saves derive that identity from the
  user's saved profile. Each checked, already-saved branch can expand into a
  separate preview editor with HTTPS URL, write-only Cloudflare Client ID and
  Secret, connection test, verified save/rotation, and removal. Saves only show
  configured state after the server validates the effective URL and token.
  Preview mutations use their own branch-specific endpoint so visibility saves
  preserve unchanged tokens.
- Account selectors offer only unassigned credentials plus the current user's
  saved credential. The server and database enforce the same one-to-one rule.
- The server omits profiles classified as `agent_test`, keeping AI-only feature
  fixtures out of the Users list and all human account selectors.

## Flow

1. Load the current principal from the auth-session snapshot.
2. Fetch only the administration datasets allowed by the effective User
   Management Read/Edit permission.
   During remembered-administrator offline grace, skip every dataset request and
   show the shared retrying degraded state until authoritative identity returns.
3. Submit every mutation with the DevRyan CSRF header.
4. Refresh the affected server state and surface generated passwords or
   targeted invite links transiently for out-of-band delivery.
5. Initialize one bounded interaction collector after the auth gate mounts.
   Programmatic and native copies retain metadata in session storage while up
   to 64 KiB of copied text stays in memory until its asynchronous flush;
   explicit file navigation emits project-relative paths without blocking the
   action.

## Integration

- Routed by `components/views/SettingsView.tsx` through the `users` settings slug.
- Consumes `/api/admin/*` contracts owned by
  `packages/web/server/lib/multi-user/runtime.js`.
- `lib/interactionAnalytics.ts` owns low-frequency file-open/copy batching and
  byte-bounds copied-text requests without putting bodies in shared state;
  `lib/clipboard.ts` is the single programmatic copy boundary and suppresses
  duplicate native-copy observations for its `execCommand` fallback.
- Shared primitives: `components/ui/table.tsx`, `components/ui/dialog.tsx`,
  `sections/shared/SettingsPageLayout` and `SettingsSection`.
