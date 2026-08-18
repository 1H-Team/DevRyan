# packages/web/server/lib/quota/utils/

## Responsibility
Shared quota helper layer for auth-source discovery, usage transformation, and response formatting.

## Design
- `auth.js` normalizes credentials from provider-specific config/data files.
- `transformers.js` converts provider payloads into quota module canonical windows/models shape.
- `formatters.js` + `buildResult` keep success/error payload contract consistent across providers, including non-fatal warnings and value-only rows.

## Flow
1. Provider module reads tokens/metadata through auth helpers.
2. Raw provider responses are transformed into normalized usage records.
3. Final payload is wrapped via shared formatter before returning to registry/routes.

## Integration
- Imported by `quota/providers/**` implementations.
- Forms the common contract that `quota/providers/index.js` relies on for mixed-provider output.
