# Shared runtime codemap

## Entry points

- `index.js` / `index.d.ts` — package exports and host-facing types.

## Modules

- `lib/safe-archive.js` — bounded HTTPS ZIP downloads, archive preflight, safe extraction, tree audit, and transactional installation.
- `lib/safe-archive.test.js` — adversarial archive and rollback coverage.
- `lib/config-apply-coordinator.js` — revisioned mutation batching, idle/forced managed apply, external-runtime acknowledgement, and concurrency control.
- `lib/config-apply-coordinator.test.js` — pending-revision, authorization, failure, concurrency, and external-runtime coverage.
- `lib/quota-adapters.js` — injected cross-host adapters and normalized usage contracts for z.ai, Kimi, Codex, xAI, and DeepSeek.
- `lib/quota-adapters.test.js` — fixture-driven provider parsing, refresh, warning, and failure coverage.

## Where to change things

- Change cross-host ZIP security rules only in `lib/safe-archive.js`; keep web and VS Code as thin adapters.
- Change configuration batching or restart-state policy only in `lib/config-apply-coordinator.js`; host adapters provide live-session and restart operations.
- Change shared provider request/parsing rules only in `lib/quota-adapters.js`; credential discovery and persistence stay with each host.
- Add any new cross-host runtime module here only when it has no UI or host-process ownership.
