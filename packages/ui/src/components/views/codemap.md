# packages/ui/src/components/views/

## Responsibility
Top-level view containers used by app routes/tabs (chat, settings, git, etc.).

`TerminalView.tsx` checks the current runtime's typed persistent-terminal
capability before mounting session, replay, transport or viewport owners.
Unsupported or failed reads display unavailable; replaced runtime APIs cannot
reuse a previous grant. Compatibility adapters without the optional capability
operation keep their existing presentation; the server still owns refusal.

## Design
Container components coordinate layout regions and feature module composition. `lazyViews.tsx` is the single recovery-aware lazy registry and Suspense/error boundary for heavyweight top-level views shared by web shells. `SettingsFrame.tsx` and `ManagedSettingsFrame.tsx` are lightweight, eagerly available Settings shells with synchronous navigation, Back and home content. Only section content suspends, using the compact `SettingsLoadFallback`; there is no full-screen entry fallback. `SettingsDataBoundary.tsx` and `ManagedSettingsDataBoundary.tsx` keep store activation effects behind separate lazy entrypoints, loaded only for destinations that need them. `preparedSettingsComponent.ts` owns bounded ten-second, recovery-aware component resources; preload and rendering share both promises and resolved components. `settingsSectionLoaders.ts` starts destination/sidebar/data imports together, checks current runtime and account access, and gives explicit navigation priority over sequential idle warming. `useSettingsEntryPreload.ts` warms only the remembered permitted destination after `MainLayout` mounts behind authentication/startup readiness, and reuses the same resources for entry-button intent. Both frames retain the displayed section until the latest requested section is ready, cancel pending navigation on unmount/policy changes, and immediately stop displaying revoked destinations. The shared preference layout uses separate resources for Appearance/Chat, Shortcuts, Notifications, Voice and Tunnel. Session Defaults (`sessions`) and Agents share the Agents sidebar resource, so moving between them never remounts it on desktop. Both shells expose pending configuration-apply status. `config-apply/ConfigApplyControls.tsx` projects the revisioned pending/waiting/applying/failed/external states into Settings surfaces and exposes wait-until-idle, administrator force, retry, and external acknowledgement without embedding restart policy in UI. `config-apply/useConfigApplyStatusLifecycle.ts` refreshes on Settings visibility and window focus, then keeps the one-second transient-state poll alive from the always-mounted web/Electron shells until the host reaches a stable state. `planViewLoader.ts` owns the shared recoverable Plan import so the saved-plan status action can warm only that chunk without importing the full lazy-view registry. `PierreDiffViewer.tsx` keeps unchanged regions collapsed initially; activating any omitted-lines separator switches the selected file revision to full-file rendering in both unified and split layouts. The one-way `DeferredLazyView` gate keeps Multi Run out of initial startup, then preserves the mounted controlled-dialog lifecycle after first activation.
`BotView.tsx` is the thin Production Bot host gate mounted only for the explicit
Bots sidebar audience. It resolves the selected Bot
and current principal's owner channel, renders the Bot-owned chat surface on
web/Electron, and returns the deliberate unsupported presentation before any
runtime mutation path in unsupported hosts.
`SettingsView.access.ts` keeps global Coding Agent Skills and MCP configuration
inside their existing host-setting authorization boundary. Bot-specific Skills
are selected only from the Bot Resources tab; Bot-specific MCP configuration is
not exposed. The policy-filtered managed shell preserves its normal settings
boundary without maintaining a separate Bot capability-assignment audience.

`SettingsSectionTabs.tsx` is the accessible Base UI workspace switcher for
grouped settings destinations; its tab list sizes itself by tab count.
`SettingsFrame.tsx` uses it for the Plugins hub (Plugins, Skills, MCP Servers)
and desktop/web Remote Connections; `ManagedSettingsFrame.tsx` builds the same
permission-filtered Plugins hub. Agents is untabbed in both shells: Session
Defaults opens from the Agents sidebar (or stands alone without Agents access),
and the managed shell adds the compact Agents picker below `md` where its split
sidebars are hidden. Providers is untabbed in both shells: usage
renders inside each provider page, and the standalone Usage page is only the
fallback for accounts without Providers access. The active child remains the
persisted settings slug so legacy links and command-palette entries select the
exact tab; on mobile, switching hub tabs lands on that tab's list.

## Flow
Navigation selects a view; view binds data hooks and renders feature sections.

`GitView.tsx` treats generated commit highlights as body details, inserting a validated subject followed by a blank line and bounded bullet list. Host warnings disclose when the local fallback supplied the draft after the pinned Zen model (DeepSeek V4.1 Flash) failed, naming the failure category.

## Integration
Connected to router/state stores and feature component trees.
