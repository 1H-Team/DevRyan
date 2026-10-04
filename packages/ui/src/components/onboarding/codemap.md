# packages/ui/src/components/onboarding/

## Responsibility
First-run onboarding components guiding initial setup.

## Design
Step-based composition with explicit progression and completion state.

## Flow
User progresses through setup tasks; each step persists settings/auth selections.

## Integration
Connected to settings/auth/provider modules and app routing.

- `BundledRuntimeSetup.tsx` shares the existing native-only client health check, app-owned reload retry and DevRyan updater across local and first-launch views. There are no standalone OpenCode installers or path settings. The existing remote connection and released Tauri host-choice flow remain available. Recovery copy describes bundled runtime readiness.
- The same setup surface includes `../sections/providers/BundledRuntimeUpdate.tsx`:
  an administrator explicitly applies an available bundled runtime using its
  current selector revision. Reading readiness never changes the selection.
