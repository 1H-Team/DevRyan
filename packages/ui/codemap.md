# packages/ui/

## Responsibility
Workspace package for the shared React UI runtime used by web, Electron, and VS Code shells. It owns app composition, feature components, client-side state, sync/event handling, and runtime API bridging.

## Design
- **Runtime-agnostic UI package**: runtime differences are abstracted behind injected APIs (`window.__OPENCHAMBER_RUNTIME_APIS__`) and `lib/desktop` helpers.
- **Store + sync split**: long-lived app/preferences state lives in Zustand stores (`src/stores/*`), while high-frequency live session/message state is handled by `src/sync/*` child stores and event reducers.
- **Managed-task isolation**: low-frequency DevRyan-owned scheduler projections live in `src/stores/useManagedOrchestrationStore.ts`; they never enter provider-native tool projection or high-frequency session/message stores.
- **Thin entrypoint**: `src/main.tsx` wires providers, hydration side effects, and mounts `App`.
- **Header usage composition**: reusable provider-tab and selected-provider quota panels live under `src/components/layout/usage/` and are shared by the desktop/mobile header menus plus the VS Code header surface.
- **Authoritative plan files**: `src/lib/plans/sessionPlanPersistence.ts` delegates create-once storage to the runtime `SessionPlansAPI`, deduplicates lifecycle/card saves, and updates `src/stores/useSessionPlanFileStore.ts`. Web/Electron use the scoped server plan-revision route; VS Code provides equivalent deterministic storage through its bridge adapter.
- **User-facing session visibility**: `src/lib/sessionVisibility.ts` centralizes exact internal-session classification for navigation surfaces, composing DevRyan-owned Git helper registration with external SmartFetch secondary-model helper titles while leaving authoritative sync state untouched.
- **Managed interaction analytics**: `src/lib/interactionAnalytics.ts` is a
  bounded, session-scoped collector for explicit file navigation and copy
  metadata. It stays outside Zustand hot paths; `src/lib/clipboard.ts` is the
  shared programmatic-copy boundary and never sends clipboard text.

## Flow
1. Host runtime injects runtime APIs and loads UI entrypoint.
2. `src/main.tsx` initializes locale/appearance persistence and mounts provider tree.
3. `src/App.tsx` initializes config/runtime wiring, mounts sync provider, and routes to views.
4. Feature components consume selectors/hooks from `stores`, `sync`, and `lib` helpers.
5. Managed-task events bypass directory queues, while snapshot/cancel/recovery and confirmed primary-agent handoff actions use `src/lib/orchestrationApi.ts` against the host-owned `/api/orchestration/*` contract.

## Integration
- **Depends on**: `@opencode-ai/sdk` (sessions/messages/providers), `@openchamber/orchestration-runtime` (provider prompt-tool policy plus managed-task projections/envelopes), host-provided runtime APIs, and backend `/api/*` routes.
- **Consumed by**: `packages/web`, `packages/electron`, and `packages/vscode` renderer entrypoints.
- **Cross-package contract**: shared types and runtime capability gates (desktop/vscode/web) keep one UI codepath across shells.
- **OpenCode transport**: `src/lib/opencode/client.ts` creates SDK clients and direct local API reads with browser `cache: "no-store"` for dynamic GET/HEAD paths so stale Chromium profile cache cannot seed session/chat state.
