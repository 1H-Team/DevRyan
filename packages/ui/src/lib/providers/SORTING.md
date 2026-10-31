# Provider / model picker sorting

All UI surfaces that render a grouped **provider → models** picker must derive their display order from the helpers in [`sorting.ts`](./sorting.ts).

## Conventions

- **Providers** sort by `getProviderDisplayName(provider)` from [`display.ts`](./display.ts). Tie-break on `provider.id` for stable ordering when display names collide (e.g. OAuth-aware relabeling).
- The built-in `openai` provider displays as **ChatGPT** for both ChatGPT sign-in and API-key connections. Model fields, picker groups, and provider settings use this shared label for display, search, and sorting; execution IDs and stored provider names stay unchanged. Custom provider IDs keep their supplied names, including OpenAI.
- **Models** sort by `model.name`, falling back to `model.id`. Tie-break on `model.id`.
- Comparison is **case-insensitive** and uses a shared `Intl.Collator` (`sensitivity: 'base'`, `numeric: true`) so numeric suffixes order naturally (`gpt-4` < `gpt-10`).
- Helpers always return **new arrays** and shallow-clone providers when re-sorting nested models. Never mutate store/API snapshots.

## When to use which helper

- `sortProvidersByDisplayName(providers)` — flat provider lists (e.g. providers sidebar).
- `sortModelsByDisplayName(models)` — model-only lists.
- `sortProviderTreeForPicker(providers)` — the common case: nested provider → models dropdowns. Pass the already-filtered list (hidden models, search query, allowed providers) so sorting is the final step.

## What stays untouched

- **`favoriteModelsList`** from [`useModelLists`](../../hooks/useModelLists.ts) — order reflects user-defined favorites.
- **Authoritative store/API arrays** in `useConfigStore` (e.g. picking `provider.models[0]` when switching provider) — fallback selection must follow the server's canonical order. Sorting applies to **derived UI lists only** (typically inside a `useMemo`).

## Adding a new picker

Build the filtered list first (hidden/visible/search), then return `sortProviderTreeForPicker(filtered)`. No new ad-hoc `.sort(...)` calls on provider or model arrays in components.
