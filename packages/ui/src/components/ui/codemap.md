# packages/ui/src/components/ui/

## Responsibility
Shared UI primitives and wrappers (buttons, dialogs, menus, toasts, etc.).

## Design
Thin abstraction layer around Base UI/Radix/Hero patterns plus project styling defaults.
`ScrollShadow` keeps its visibility attributes idempotent so its subtree
`MutationObserver` cannot schedule itself indefinitely.
`number-input-value.ts` owns synchronous step/clamp arithmetic so controlled
number steppers cannot reuse a stale parent value during rapid activation.

## Flow
Feature components compose these primitives and pass business logic via props/callbacks.

## Integration
Consumed across all UI domains; aligned with theme tokens and typography utilities.
