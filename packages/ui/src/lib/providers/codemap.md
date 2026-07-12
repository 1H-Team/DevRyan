# packages/ui/src/lib/providers/

## Responsibility
Provider/model metadata helpers and configuration transformation logic.

## Design
Domain mapping normalizes provider schemas for UI selectors/forms. `modelAvailability.ts` interprets additive host availability metadata, resolves stale persisted choices to an available same-provider/global fallback, blocks unavailable selections and send snapshots, and provides actionable OAuth/API-key guidance without changing model IDs. `modelVisibility.ts` folds the gate into shared picker filtering; specialized multi-run, scheduled-task, and todo selectors use the same availability helpers.

## Flow
Raw provider data is loaded, normalized, and exposed to settings/chat controls.

## Integration
Integrated with provider sections, agent manager, and opencode client config.
