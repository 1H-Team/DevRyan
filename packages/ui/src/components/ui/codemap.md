# packages/ui/src/components/ui/

## Responsibility
Shared UI primitives and wrappers (buttons, dialogs, menus, toasts, etc.).

## Design
Thin abstraction layer around Base UI/Radix/Hero patterns plus project styling defaults.
`RuntimeLoadingScreen.tsx` is the theme-token-driven, full-surface DevRyan loading primitive shared by the web/Electron startup readiness gate and managed OpenCode restart overlay; static host splashes mirror its large current-color mark and status geometry.
`ScrollShadow` keeps its visibility attributes idempotent so its subtree
`MutationObserver` cannot schedule itself indefinitely.
`number-input-value.ts` owns synchronous step/clamp arithmetic so controlled
number steppers cannot reuse a stale parent value during rapid activation.
`OverlayScrollbar.tsx` owns the reusable overlay thumb interactions, while
`overlayScrollbarBehavior.ts` owns its testable geometry, desktop persistence,
and auto-hide policy without weakening Fast Refresh boundaries.

## Flow
Feature components compose these primitives and pass business logic via props/callbacks.

## Integration
Consumed across all UI domains; aligned with theme tokens and typography utilities.
