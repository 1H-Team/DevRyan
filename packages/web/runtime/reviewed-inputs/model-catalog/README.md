# Reviewed model catalog

Exact public runtime metadata captured from [https://models.opencode.ai/api.json](https://models.opencode.ai/api.json). This data contains provider and model definitions, not account credentials.

- Retrieved UTC: `2026-10-02T07:29:13.740Z`
- HTTP status: `200`
- Byte size: `5293409`
- SHA-256: `1290e78c59b72a425cb6c39c1c354a780a4e002605f03c9867f17271c7cb04b9`

`DevRyan-model-catalog.json` retains the response bytes unchanged. `provenance.json` records its source and comparison against the preceding selected-model observation. The native runtime embeds this file and passes it to the pinned SDK's original catalog parser with network fetching and snapshot fallback disabled. Changing the captured data requires reviewing its provenance and rebuilding the native artifact; no ambient catalog or installed account is read.
