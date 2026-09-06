# packages/ui/src/lib/quota/

## Responsibility
Quota/usage domain helpers for aggregating and presenting consumption metrics.

## Design
Common quota model with provider adapter boundary for extensibility. The model preserves non-fatal provider warnings and supports value-only rows (`usedPercent: null`, `valueLabel`) without fabricating progress.

## Flow
Usage data is fetched and normalized, then exposed to charts/sections. z.ai, Kimi, Codex, xAI, and DeepSeek receive the same normalized server shape from `@openchamber/shared-runtime`.

## Integration
Integrated with quota providers, settings usage section, and provider config.
