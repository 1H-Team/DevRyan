# packages/ui/src/components/sections/openchamber/

## Responsibility
Feature sections for the Settings experience (providers, projects, behavior, desktop native settings, etc.).

## Design
Section-per-domain pattern with shared primitives for consistency. The About surface shows verified bundled OpenCode identity and readiness. Runtime updates ship through the existing DevRyan updater.

`DesktopBotHostStatus.tsx` adds local-only Bot hosting mode and server-reported
Docker/catalog health to About, with an explicit refresh and navigation to the
existing Bot settings. It does not change runtime preferences or expose native
controls to remote browsers.

Session defaults, the per-agent model summary, bundled runtime information and
Agent Browser Control are composed by `components/sections/agents/` (Session
Defaults and Runtime entries of Settings → Agents); the components they reuse
from this folder keep their own loading and persistence.

Settings → Appearance: `OpenChamberVisualSettings.tsx` is a composition root.
`appearance/visibleSettings.ts` orders eight sections (Theme, Typography,
Layout, Conversation, Code & Files, Composer, Regional, Mobile & Install) and
drops rows the page, device or host cannot show. Each `appearance/*Section.tsx`
subscribes to its own store fields and keeps that setting's persistence path
(direct `updateDesktopSettings` handlers, `lib/appearanceAutoSave.ts`, theme
context, or persisted UI store). Every row has a visible description through
the shared `SettingsField` primitives; single choices use option cards, themes
use `ThemeSwatch` cards painted from each theme's own colors (color properties
only). With `preview`, `AppearancePreview.tsx` renders a static mock chat that
follows the live CSS variables for theme, fonts, text size and density, plus a
chat-width minimap; it never imports the real chat, Markdown, Mermaid or diff
renderers. It sits in a sticky side column when the page container is at least
56rem wide and behind a Show Preview toggle otherwise. The Chat page reuses the
same sections without the preview. Code Font stays independent from Terminal
Font Size and Terminal Quick Keys: `visualSettingsPolicy.ts` hides terminal-only
rows and empty sections when the effective Terminal capability is disabled,
while stored terminal preferences remain untouched.

`NotificationSettings.tsx` has one foreground web-notification activation path.
`notificationToggle.ts` requests browser permission at most once from the user
gesture, persists the personal preference before showing it enabled, and keeps
the previous state with an actionable error when permission or persistence
fails. Notification template reads also fall back to the centralized total
six-event template shape, so sparse legacy account state cannot crash the
editor when notification controls become visible. Background push-subscription
controls remain separate.

## Flow
Settings navigation selects a section; section reads/writes config through hooks/APIs. `AboutSettings.tsx` is also routed as the cross-runtime Settings → About page. `SessionRetentionSettings.tsx` exports the session auto-cleanup rows (rendered by Session Defaults) and About's Data & Storage block, which owns one unified Error Logs control: session-count/size status, export, and clearing the past 24 hours, 7 days, 14 days, or all logs. In Electron, the confirmed all-logs clear also removes the Chromium application cache and shows its size on a second line; bounded time ranges leave the cache untouched, and chat history is never part of either operation. `OpenCodeStorageSettings.tsx` follows as the read-only OpenCode Storage block: database size, WAL, event rows, reclaimable space, the last recorded cleanup (history from earlier versions), and a Dry Run that reports what the OpenCode 1 cleanup would remove. DevRyan runs no cleanup and offers no compaction: a mutating pass needs an OpenCode 1 runtime, which runtime selection never records. A native OpenCode 2 database (`generation: 2`, `error: 'v2_database'`) shows its size and that cleanup is not needed, with Dry Run off; any other unrecognised layout keeps the fail-closed unknown-layout notice. It renders only when the runtime diagnostics API exposes the optional `getOpenCodeStorage`/`compactOpenCodeStorage` members (web/Electron). About's Desktop App block renders `DesktopKeepAwakeSettings.tsx` and `DesktopNetworkSettings.tsx` only for the local desktop origin. Chat settings own Open Files in Preview Mode (`defaultFileViewerPreview`).

`TunnelSettings.tsx` owns managed-remote fixed-origin profiles. It edits `originPort`, shows the exact
Cloudflare service URL, and displays the stable-origin-to-active-port relay mapping returned by the
server instead of asking users to update Cloudflare when DevRyan's active port changes. Managed
Remote follows the server's access policy: Supabase On exposes the stable hostname through
account login; Off exposes a private owner link with QR/copy and replacement-link controls.
Start/restart remain available to local owners independently of principal scope; the server
enforces authentication. `tunnelStatusPresentation.ts` selects the usable URL from that policy.
Managed startup never submits Bot selections. Explicit Bot-link issuance is separate from startup.

`PasskeySettings.tsx` manages passkeys for the local UI password lock
(`--ui-password` / `OPENCHAMBER_UI_PASSWORD`) and is mounted on the local User
Management page. It renders nothing unless `/auth/passkey/status` reports
passkeys enabled, which excludes hosts without the lock, tunnel scope and
multi-user mode. Listing and revoking work without WebAuthn; only adding a
passkey requires a secure context. Sign Out Everywhere confirms first because
the host also deletes every saved passkey and rotates its session secret.

`useGitHubDeviceFlow.ts` owns the reusable OAuth start/poll/cancel flow and
`GitHubDeviceFlow.tsx` renders its shared verification panel for local and
managed GitHub account controls in User Management.

`AgentBrowserControlSettings.tsx` is local-Electron-only. Its existing enable toggle remains independent from the managed `agent-browser` installation status. The section reads expected/installed versions and repair issues through local-sender-gated desktop IPC, invokes Repair through IPC rather than HTTP, shows the global active-lease count, and surfaces concise managed-skill conflict/issue messages without exposing filesystem paths. Leases start hidden and each receives a separate local-only capability.

## Integration
Integrated with views, lib adapters, and settings/auth stores. `OpenCodeVersionSection.tsx` reads only verified bundle metadata from `/api/config/opencode-resolution`; `openCodeVersionState.ts` rejects unsupported identities and keeps unavailable readiness explicit. OpenCode updates ship through the existing DevRyan updater. Its Check for Updates button calls `/api/config/opencode-update-check` only on click (abortable, component-local state) and compares numeric versions via `compareUpstreamVersion`; the result is labelled as the latest upstream release, not a DevRyan-qualified update. `OpenCodeCliSettings.tsx` retains its compatibility component name but presents bundled runtime information, with no standalone binary selection.

## Loading boundaries

`OpenChamberPage.tsx` is a lightweight layout selecting one resource from
`openChamberSectionResources.ts`. Appearance/Chat share `VisualSectionContent.tsx`; Shortcuts, Notifications,
Voice and Tunnel load independently. Every caller names its section. Preparing
a section loads the same resource that rendering consumes, without fetching
section data.
