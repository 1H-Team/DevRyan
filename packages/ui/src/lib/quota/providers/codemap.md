# packages/ui/src/lib/quota/providers/

## Responsibility
Provider-specific adapters for usage/quota data normalization.

## Design
Strategy-style provider modules map heterogeneous quota payloads to a common model. The provider catalog includes xAI and DeepSeek alongside existing providers.

## Flow
Quota fetch selects adapter by provider and returns normalized usage data; presentation retains valid rows plus partial-parse warnings and omits progress chrome for value-only balances.

## Integration
Used by lib/quota and usage settings sections.
