# packages/ui/src/components/views/

## Responsibility
Top-level view containers used by app routes/tabs (chat, settings, git, etc.).

## Design
Container components coordinate layout regions and feature module composition. `lazyViews.tsx` is the single recovery-aware lazy registry and Suspense/error boundary for heavyweight top-level views shared by web shells. Settings uses a bounded ten-second load and a visible `SettingsLoadFallback` for its initial cold entry and genuine recovery states. `settingsViewLoader.ts` owns the top-level Settings imports, while `settingsSectionLoaders.ts` owns shared preloadable component resources: intent preloads and rendering reuse the same cached import and resolved component, so a prepared section renders synchronously. Callers warm those resources on pointer/focus intent and, after either Settings shell mounts, sequentially during browser idle time for authorization-visible sections only. Both Settings shells separate the requested slug from the displayed slug, retain the current section until every destination resource resolves, mark only the requested destination busy, and commit only the latest request; direct store/router changes use the same staged path. Genuine import failures still flow through the existing recovery boundary without widening the application startup graph. `SettingsView.tsx` owns the full local/administrator settings shell, while `ManagedSettingsView.tsx` exposes its smaller policy-filtered catalog; both expose pending configuration-apply status. `config-apply/ConfigApplyControls.tsx` projects the revisioned pending/waiting/applying/failed/external states into Settings surfaces and exposes wait-until-idle, administrator force, retry, and external acknowledgement without embedding restart policy in UI. `config-apply/useConfigApplyStatusLifecycle.ts` refreshes on Settings visibility and window focus, then keeps the one-second transient-state poll alive from the always-mounted web/Electron shells until the host reaches a stable state. `planViewLoader.ts` owns the shared recoverable Plan import so the saved-plan status action can warm only that chunk without importing the full lazy-view registry. `PierreDiffViewer.tsx` keeps unchanged regions collapsed initially; activating any omitted-lines separator switches the selected file revision to full-file rendering in both unified and split layouts. The one-way `DeferredLazyView` gate keeps Multi Run out of initial startup, then preserves the mounted controlled-dialog lifecycle after first activation.
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
grouped settings destinations. `SettingsView.tsx` uses it for Providers/Usage
and desktop/web Remote Connections; `ManagedSettingsView.tsx` uses the same
presentation for its permission-filtered Providers destination. The active
child remains the persisted settings slug so legacy links and command-palette
entries select the exact tab.

## Flow
Navigation selects a view; view binds data hooks and renders feature sections.

`GitView.tsx` treats generated commit highlights as body details, inserting a validated subject followed by a blank line and bounded bullet list. Host warnings disclose when the shared fast local fallback supplied the draft.

## Integration
Connected to router/state stores and feature component trees.
