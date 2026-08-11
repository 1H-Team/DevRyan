# packages/ui/src/components/

## Responsibility
Contains all user-facing React components, organized by feature area (chat, settings sections, session tools, terminal, onboarding, shared UI primitives).

## Design
- **Domain folders over page-only structure**: chat and settings features keep view logic close to local helpers/hooks.
- **Shared primitives layer**: `ui/` wraps Base UI / common controls (dialogs, dropdowns, tooltip, toaster, skeleton, etc.) for consistent styling and behavior.
- **Runtime-capable composition**: desktop/vscode-specific shells are isolated in targeted components while reusing core chat/settings surfaces.
- **Error isolation**: boundary components (e.g., chat/view-level boundaries) prevent full-app crashes from feature failures.

## Flow
1. View containers (`views/*`) select major surfaces (chat/settings/git/etc.).
2. Feature components read from `sync/*` and `stores/*` via narrow selectors.
3. User actions call sync/session actions or store actions.
4. Render-only components receive normalized props from containers/hooks.

## Integration
- Depends on `hooks/`, `lib/`, `sync/`, and `stores/` for behavior/state.
- `sections/*` provides lazily loaded settings page modules. `views/SettingsView.tsx` owns the full local/administrator shell; `views/ManagedSettingsView.tsx` is the policy-filtered managed-user entrypoint so restricted sessions never evaluate administrator-only settings code. `sections/bug-reports/` adds a managed-only page whose administrator panels are separately lazy and locally stateful.
- `chat/*` is the primary consumer of live session/message stream data.
