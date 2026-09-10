# Provider recovery transport fixture

`runtime-conformance.mjs` launches an explicitly selected OpenCode 1.18.25 binary,
the bundled guard plugin, the real shared host, and a loopback fake provider. It
isolates XDG storage, the OpenCode test home, project config, and provider keys.
It does not connect to a running application. OpenCode may populate its own SDK
dependencies inside the temporary fixture directory during first startup.

Run from the repository root with `DEVRYAN_TEST_OPENCODE_BIN` set to the installed
binary. `DEVRYAN_RECOVERY_FAULT` selects `heartbeat` (default), `silent-sse`,
`non-sse`, `missing-headers`, or `semantic`. The first four require exactly one
successful automatic recovery; semantic silence must stop without recovery.
Failure exits nonzero. Reports remain under `.tmp/provider-recovery-fixture-*`.

This is opt-in: ordinary unit tests never launch a provider runtime. OAuth and
packaged native-shell acceptance are separate release gates. The fixture uses
only a fake API key and is not evidence about OAuth-specific fetch overrides.


Claude-shaped transport scenarios use `DEVRYAN_RECOVERY_PROVIDER=anthropic`.
`DEVRYAN_RECOVERY_FAULT=upstream-timeout` sends the exact 208771 ms error envelope;
`tool-input` interrupts an edit's arguments and requires zero recovery attempts
and an unchanged sentinel file. Both select Anthropic automatically. Heartbeat,
silent-SSE, missing-header, non-SSE, and semantic scenarios accept either provider.
The fixture uses an explicit fake-provider conformance attestation and records
`productionClaudeConformance: false`. It never loads Meridian/Claude OAuth and
cannot certify the production managed Claude path. The fixture uses only the isolated XDG OpenCode config directory and omits
`OPENCODE_CONFIG_DIR`, avoiding a second explicit initialization of the same configuration.
