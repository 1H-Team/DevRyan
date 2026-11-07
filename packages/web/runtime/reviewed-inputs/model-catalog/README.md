# Reviewed model catalog

Exact public runtime metadata captured from [https://models.opencode.ai/api.json](https://models.opencode.ai/api.json). This data contains provider and model definitions, not account credentials.

- Retrieved UTC: `2026-11-07T07:35:11.754Z`
- HTTP status: `200`
- Byte size: `5966378`
- SHA-256: `3ef6abc242c7316549ef03b659b40372c92365ce7ef8fdf1fb415e6afafe05c5`

`DevRyan-model-catalog.json` retains the response bytes unchanged. `provenance.json` records its source and comparison against the preceding selected-model observation. The native runtime embeds this file and passes it to the pinned SDK's original catalog parser with network fetching and snapshot fallback disabled. Changing the captured data requires reviewing its provenance and rebuilding the native artifact; no ambient catalog or installed account is read.

## Refreshing

A model released upstream reaches users only through a refreshed snapshot. `bun run catalog:refresh` (`scripts/model-catalog-refresh.mjs`) captures the live response, rewrites `provenance.json` and the lines above, and prints the added and removed model ids per provider for review. Commit the directory and rebuild the native runtime. Two gates keep it current: `scripts/model-catalog-refresh.test.mjs` requires a row for every model in the pinned core's ChatGPT allow-list (which hides allow-listed models without one), and release preflight fails when the live catalog has a model of a tracked provider that the snapshot lacks (`bun run catalog:check` runs the same comparison).
