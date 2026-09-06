# packages/ui/src/

## Responsibility
Implements the UI application: bootstrapping, top-level app orchestration, feature views, state systems, runtime contexts, and reusable libraries.

## Design
- **Provider-first composition**: i18n, theme system, auth gate, runtime API, and sync providers are stacked in entrypoint/app.
- **Feature verticals**: `components/` groups user-facing surfaces (chat, settings sections, session/terminal/voice).
- **State layers**:
  - `stores/`: persisted UI/config/workflow preferences and low-frequency feature state.
  - `sync/`: SSE/event-pipeline driven live data materialization for sessions/messages.
- **Streaming diagnostics**: renderer timing marks are emitted from the event pipeline, sync reducer commit, assistant text commit, and status-idle surfaces through `stores/utils/streamDebug.ts` without prompt or response text.
- **Utility domains**: `lib/` contains domain helpers (router, opencode client, git, theme, terminal, i18n, permissions, quota).

## Flow
1. `main.tsx` starts locale and persisted preference hydration, then renders `App`.
2. `App.tsx` initializes runtime wiring and sync bootstrap, then selects view surfaces.
3. UI interactions update Zustand stores or call sync/session actions.
4. Sync/event reducers ingest server events, update live session/message state consumed by chat and sidebars, and clear stale working indicators when terminal assistant finishes arrive before idle status.

## Integration
- `apps/` exposes alternate app wrappers (e.g., Electron mini-chat embedding).
- `contexts/` provides cross-cutting concerns (theme, runtime API registry, drawer, diff worker).
- `types/` and `constants/` define shared contracts reused across components, hooks, and stores.
