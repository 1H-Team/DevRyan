# packages/ui/src/components/auth/

## Responsibility

Authentication UI components for login, token/device flows, dependency and
schema failures, local session reset, and loopback agent verification.

## Design

- `SessionAuthGate.tsx` owns rendering, password/passkey submission, retry,
  partial-failure-safe local reset, and explicit developer/admin fixture login.
- `sessionAuthState.ts` is the pure response classifier and deterministic
  developer-first agent identity ordering used by the gate and its tests.

## Flow

`GET /auth/session` responses are classified as authenticated, locked,
rate-limited, identity unavailable, schema migration required, or an unexpected
server response. Only a rejected fetch is rendered as “Unable to reach server.”

## Integration
Integrated with lib/opencode/github auth endpoints and settings views.
