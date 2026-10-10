# ChatGPT sign-in primary transport

## Incident and reproduction

The attended Electron 2.0.6 / OpenCode 2.0.26 run on 10 October 2026 failed
before tools or delegation. Session `ses_ed94b8ce0ffeRhdz38bzGqfS1H` was sent
at 16:45:22.814 UTC and failed after 3,377 ms with
`provider.invalid-output`: `Failed to read openai/openai-responses stream`.
The independent title request completed over HTTP. The diagnostic journal had
no reported gaps, but did not retain the primary request's underlying refusal.

The native primary turn requests a session WebSocket, and OpenCode's OpenAI
provider defaults to that transport. DevRyan's SIWC boundary refuses WebSocket
handshakes. That refusal occurs before the native socket-open fallback and is
later wrapped as a generic stream error. The prior missing-Content-Type SSE
repair is already present; it does not address transport selection.

Before changing runtime code, the derived production-composition regression in
`scripts/opencode-v2-native/controller-providers.graph.test.ts` was run with
explicit WebSocket transport. It failed because only the title reached the
physical HTTP transport (one receipt instead of two). Its synthetic hook trace
recorded this bounded evidence:

```json
{"domain":"session","name":"experimental.ws.handshake","failed":true,"reasons":[{"tag":"Die","code":"native_openai_route_unreviewed","name":"HostRefusal"}]}
```

The existing base fixture forced HTTP. The final matrix covers omitted,
explicit WebSocket and explicit HTTP settings. This fixture composition selects
HTTP when the setting is omitted; that case does not reproduce the installed
app's default. The explicit WebSocket case asserts that native preparation
offers WebSocket before DevRyan removes the option, and exercises the failure
mechanism above.

## Repair and focused evidence

The existing provider request decorator asks the OpenAI credential owner for a
boolean SIWC policy and removes only `options.webSocket`. Already-HTTP requests
avoid another account lookup, API-key requests preserve their transport, and
selection failures propagate. Physical hooks continue enforcing fresh account
identity and rejecting unsupported routes.

Physical OpenAI hook refusals now emit an admitted `provider-refusal` observation
with a finite allowlist of codes, request kind and hook name. Raw errors, URLs,
request bodies and credentials are excluded, and observation failures do not
replace the original refusal.

- Native OpenAI and provider wrapper tests: 25 passed, 251 assertions; cover
  account changes, all four request kinds, preserved API-key transport and
  selection failure behavior.
- Observation and sanitizer tests: 20 passed; cover safe refusal projection,
  original-error preservation and rejection of extra sensitive fields.
- Native provider graph: 3 passed, 9 top-level assertions; each setting exercises
  a real native read-tool round trip, primary/title HTTP requests, generate and
  compaction, physical observation, no WebSocket hooks or upgrades, and existing
  account/cancellation checks.
- Runtime-host TypeScript check passed.
- Compiled native artifact build and isolated native factory startup passed.
  [Sanitized startup proof](startup-proof.json) records scope and clean shutdown.
  Build ID: `a92aad080f25fdc8f780b44c215a987668f0bf6404be57d03d88a09f52b7fa36`.
  Manifest SHA-256: `53a818082dddde5b46a930f7de997ff68d3dccc364caa7c2a8ca37675603d7a2`.

## Verification status

Workspace build and bundle budgets passed (web-main gzip 1,442,996 bytes against
a 1,456,388-byte limit). Full validation passed lint, TypeScript and docs before
stopping at one unrelated Bun startup-health response parse failure (1,319 of
1,320 Node tests passed). The five isolated readiness tests then passed. A full
test-stage retry passed readiness but hit two release-fixture subprocess
timeouts (1,318 of 1,320 Node tests passed). With the existing
`DEVRYAN_SCRIPT_TEST_CONCURRENCY=2` setting, all 1,320 Node tests passed.

The remaining script and package suites were then run sequentially. All
completed, but the first resumed runner placed temporary fixtures inside the
checkout without a Git discovery ceiling. This incorrectly made non-Git
fixtures resolve to DevRyan; that run's harness warm-up failure and web Git
failures are invalid as product regression evidence. The web stage of that run
was stopped, then rerun with an explicit Git ceiling. No tracked product files
were changed by these fixtures.

After the broad run, original-limit isolated retries passed:

- Command-admission mutex: 1/1.
- Provider transport matrix: 3/3; explicit WebSocket case completed in 3.83 s.
- Native browser fixture: 3/3, without the larger timeout used for an earlier
  diagnostic-only probe.
- Harness ledger warm-up: 1/1 with corrected Git isolation; all other harness
  tests had passed in the resumed suite.

All other resumed package stages passed, including UI (4,091 tests). The
corrected web Vitest run passed 6,625 of 6,626 tests across 541 files. Its only
failure was the FIFO/socket setup-seed fixture: the resumed runner's long
temporary path did not support the Unix socket. That exact test passed with a
short repo-owned temporary root and the Git ceiling retained. The separate
native web stage passed all 14 tests across three files.

Assertions and test deadlines were not changed. Every observed failing test
has a subsequent passing run, but this is a composed verification result, not
a claim that one uninterrupted `validate:full` invocation passed. The initial
failures and runner corrections remain part of this record.

No successful live-provider rerun is established by these isolated checks; the
user's installed app and credential store were not changed.
