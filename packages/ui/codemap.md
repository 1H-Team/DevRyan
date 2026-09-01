# packages/ui/

## Responsibility
Workspace package for the shared React UI runtime used by web, Electron, and VS Code shells. It owns app composition, feature components, client-side state, sync/event handling, and runtime API bridging.

## Design
- **Runtime-agnostic UI package**: runtime differences are abstracted behind injected APIs (`window.__OPENCHAMBER_RUNTIME_APIS__`) and `lib/desktop` helpers.
- **Store + sync split**: long-lived app/preferences state lives in Zustand stores (`src/stores/*`), while high-frequency live session/message state is handled by `src/sync/*` child stores and event reducers.
- **Managed-task isolation**: low-frequency DevRyan-owned scheduler projections live in `src/stores/useManagedOrchestrationStore.ts`; they never enter provider-native tool projection or high-frequency session/message stores.
- **Production Bot isolation**: `src/lib/botsApi.ts` and `src/lib/botsDesktopApi.ts` keep the server and local-Electron contracts explicit. `src/apps/BotsEventOwner.tsx` reconciles principal-filtered snapshot/sequence events into `useBotsStore`, `useBotChannelStore`, and `useBotOperationsStore`; `src/apps/botEventConnection.ts` owns the generation-guarded EventSource/reconnect contract and fresh-snapshot health gate. Ordinary OpenCode sync branches and global UI stores are not widened.
- **Production Bot workspace**: `src/components/bots/` owns assigned-Bot navigation, canonical continuous chat, and the operations rail. A narrow session-only audience store and shared accessible tabs switch between Coding Agents and Bots without clearing either audience's selected state. `MainLayout` replaces repository/context/browser/terminal surfaces only while the Bots audience is selected; `VSCodeLayout` renders only the deliberate macOS-app requirement and never invokes runtime setup.
- **Simplified Bot settings**: `src/components/sections/bots/BotEditor.tsx` owns Overview, Resources, Memory, Members, Routines, and Lifecycle. Overview combines the public profile with revision-backed Soul/personality, Standing Role, Objectives, and compact primary Provider/Model/Thinking controls; Resources combines persistent computer files, optional on-demand Skills/SOPs, protected provider credentials, and environment secrets. Advanced instruction controls and Bot MCP configuration are absent.
- **Thin entrypoint**: `src/main.tsx` wires providers, hydration side effects, and mounts `App`.
- **Header usage composition**: reusable provider-tab and selected-provider quota panels live under `src/components/layout/usage/` and are shared by the desktop/mobile header menus plus the VS Code header surface.
- **Grouped settings destinations**: `src/lib/settings/navigation.ts` keeps Providers/Usage and Remote Tunnel/Remote Instances as permission-aware sidebar destinations while preserving their existing child slugs. `src/components/views/SettingsSectionTabs.tsx` renders the shared accessible workspace tabs used by the full and managed settings shells.
- **Authoritative plan files**: `src/lib/plans/sessionPlanPersistence.ts` delegates create-once storage to the runtime `SessionPlansAPI`, deduplicates lifecycle/card saves, and updates `src/stores/useSessionPlanFileStore.ts`. Web/Electron use the scoped server plan-revision route; VS Code provides equivalent deterministic storage through its bridge adapter.
- **User-facing session visibility**: `src/lib/sessionVisibility.ts` centralizes exact internal-session classification for navigation surfaces, composing DevRyan-owned Git helper registration with external SmartFetch secondary-model helper titles while leaving authoritative sync state untouched.
- **Managed interaction analytics**: `src/lib/interactionAnalytics.ts` is a
  bounded, session-scoped collector for explicit file navigation and copy
  analytics. It stays outside Zustand hot paths and browser persistence keeps
  metadata only; `src/lib/clipboard.ts` is the shared programmatic-copy
  boundary, while copied text is capped in memory and flushed asynchronously.
- **Branch preview administration**: User Management keeps branch visibility
  and preview credentials as separate mutations. Checked persisted branches
  expose an inline HTTPS preview editor; stored service tokens are projected
  only as a configured flag and are never prefilled into renderer state.

## Flow
1. Host runtime injects runtime APIs and loads UI entrypoint.
2. `src/main.tsx` initializes locale/appearance persistence and mounts provider tree.
3. `src/App.tsx` initializes config/runtime wiring, mounts sync provider, and routes to views.
4. Feature components consume selectors/hooks from `stores`, `sync`, and `lib` helpers.
5. Managed-task events bypass directory queues, while snapshot/cancel/recovery and confirmed primary-agent handoff actions use `src/lib/orchestrationApi.ts` against the host-owned `/api/orchestration/*` contract.
6. Production Bot events use their own SSE owner and isolated stores; principal changes replace the authorized catalog/channel/operations projection as one security boundary.

## Integration
- **Depends on**: `@opencode-ai/sdk` (sessions/messages/providers), `@openchamber/orchestration-runtime` (provider prompt-tool policy plus managed-task projections/envelopes), host-provided runtime APIs, and backend `/api/*` routes.
- **Consumed by**: `packages/web`, `packages/electron`, and `packages/vscode` renderer entrypoints.
- **Cross-package contract**: shared types and runtime capability gates (desktop/vscode/web) keep one UI codepath across shells.
- **OpenCode transport**: `src/lib/opencode/client.ts` creates SDK clients and direct local API reads with browser `cache: "no-store"` for dynamic GET/HEAD paths so stale Chromium profile cache cannot seed session/chat state.
