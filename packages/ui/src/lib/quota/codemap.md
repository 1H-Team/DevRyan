# packages/ui/src/lib/quota/

## Responsibility
Quota/usage domain helpers for aggregating and presenting consumption metrics.

## Design
Common quota model with provider adapter boundary for extensibility. The model preserves non-fatal provider warnings and supports value-only rows (`usedPercent: null`, `valueLabel`) without fabricating progress.

`providerUsageIds.ts` maps Providers-catalog ids to the quota ids that report their usage (mirroring the server's quota aliases), lists usage sources no provider covers, and encodes usage-only Providers selections. `utils.getPeakUsageWindow` picks the most-used progress window for compact meters.

## Flow
Usage data is fetched and normalized, then exposed to charts/sections. z.ai, Kimi, Codex, xAI, and DeepSeek receive the same normalized server shape from `@openchamber/shared-runtime`.

## Integration
Integrated with quota providers, settings usage section, and provider config.
