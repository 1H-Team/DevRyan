# Shared runtime codemap

## Entry points

- `index.js` / `index.d.ts` — package exports and host-facing types.

## Modules

- `lib/safe-archive.js` — bounded HTTPS ZIP downloads, archive preflight, safe extraction, tree audit, and transactional installation.
- `lib/safe-archive.test.js` — adversarial archive and rollback coverage.
- `lib/config-apply-coordinator.js` — revisioned mutation batching, idle/forced managed apply, external-runtime acknowledgement, and concurrency control.
- `lib/config-apply-coordinator.test.js` — pending-revision, authorization, failure, concurrency, and external-runtime coverage.
- `lib/quota-adapters.js` — injected cross-host adapters and normalized usage contracts for OpenCode Zen, OpenCode Go, z.ai, Kimi, Codex, xAI, and DeepSeek.
- `lib/quota-adapters.test.js` — fixture-driven provider parsing, refresh, warning, and failure coverage.
- `lib/assistant-image-sources.js` — shared supported-image canonicalization, Markdown extraction, code exclusion, and syntax stripping.
- `lib/commit-message-draft.js` — shared deadline, prompt, AI normalization/repair, model cooldown, and deterministic commit-draft fallback policy.
- `testing/assistant-image-fixtures.js` — golden parser fixtures shared by UI and web security tests.

## Where to change things

- Change cross-host ZIP security rules only in `lib/safe-archive.js`; keep web and VS Code as thin adapters.
- Change configuration batching or restart-state policy only in `lib/config-apply-coordinator.js`; host adapters provide live-session and restart operations.
- Change shared provider request/parsing rules only in `lib/quota-adapters.js`; credential discovery and persistence stay with each host.
- Change assistant image syntax rules only in `lib/assistant-image-sources.js` and update the shared golden fixtures so UI and server authorization stay equivalent.
- Change cross-host commit draft formatting, deadline, repair, or fallback policy only in `lib/commit-message-draft.js`; Git context collection and provider transport stay with each host.
- Add any new cross-host runtime module here only when it has no UI or host-process ownership.
