# packages/ui/src/components/sections/openchamber/

## Responsibility
Feature sections for the Settings experience (providers, projects, behavior, desktop native settings, etc.).

## Design
Section-per-domain pattern with shared primitives for consistency. The About surface keeps the DevRyan updater independent from the read-only OpenCode version comparison, which shows active, latest stable, and DevRyan-supported runtime versions without mutating or restarting OpenCode.

## Flow
Settings navigation selects a section; section reads/writes config through hooks/APIs. `AboutSettings.tsx` is also routed as the cross-runtime Settings → About page. Its Data Retention section owns session cleanup and one unified Error Logs control: session-count/size status, export, and clearing the past 24 hours, 7 days, 14 days, or all logs. In Electron, the confirmed all-logs clear also removes the Chromium application cache and shows its size on a second line; bounded time ranges leave the cache untouched, and chat history is never part of either operation. Desktop-only components such as `DesktopKeepAwakeSettings.tsx` and `DesktopNetworkSettings.tsx` appear only for the local desktop origin.

`TunnelSettings.tsx` owns managed-remote fixed-origin profiles. It edits `originPort`, shows the exact
Cloudflare service URL, and displays the stable-origin-to-active-port relay mapping returned by the
server instead of asking users to update Cloudflare when DevRyan's active port changes. Managed
Remote exposes the stable public hostname through normal DevRyan account login and does not render
one-time connect-link TTL, QR, or session controls. It requires a managed-account principal;
local-admin sessions see an account-setup callout and cannot start or restart Managed Remote.

`useGitHubDeviceFlow.ts` owns the reusable OAuth start/poll/cancel flow and
`GitHubDeviceFlow.tsx` renders its shared verification panel for local and
managed GitHub account controls in User Management.

`AgentBrowserControlSettings.tsx` is local-Electron-only. Its existing enable toggle remains independent from the managed `agent-browser` installation status. The section reads expected/installed versions and repair issues through local-sender-gated desktop IPC, invokes Repair through IPC rather than HTTP, shows the global active-lease count, and surfaces concise managed-skill conflict/issue messages without exposing filesystem paths. Leases start hidden and each receives a separate local-only capability.

## Integration
Integrated with views, lib adapters, and settings/auth stores. `OpenCodeVersionSection.tsx` consumes `/api/config/opencode-resolution` for active runtime metadata and `/api/opencode/update-check` for explicit upstream checks; `openCodeVersionState.ts` keeps its view-state resolution independently testable.
