# Startup and archive release qualification

This candidate combines all v2.0.7 changes with the pending directory startup,
runtime preparation and recovered-input archive changes. The requested commit
message is `release v2.0.7`, tag `v2.0.7`, release title `DevRyanv2.0.7`, and
desktop asset allowlist is exactly `DevRyan-2.0.7-arm64.dmg`.

Production build, bundle budgets and fresh native compilation passed.
Full validation passed workspace lint, type checks, documentation checks and
all deterministic suites, including 4,103 UI tests and the final native web tests.
[Web QA](qa-web.json) and [Electron QA](qa-electron.json) passed seven chat
checks each, without unexpected renderer errors or cleanup failures. Both
screenshots were inspected; sidebar, transcript and composer fit.

[Compiled native qualification](native-qualification.json) passed all 52 cases,
with no remaining mandatory gates, changed source paths or cleanup failures.
The [rejected first run](rejected-qualification.json) caught premature checking
of an admission entry before its recovered-input grant was acquired. The shared
admission owner now retains ordinary grant acquisition and supplies the early
entry only for validated archive metadata. The regression suite passed 19 tests.
The failed run's journal gap check found no gaps.

The initial full-validation attempt failed in the QA host-readiness fixture
with an empty JSON response during its 50 ms request deadline. Its isolated
rerun passed all five tests; no assertion or timeout was weakened.

No migration files are modified or untracked. Hosted pending migrations are
applied by the release workflow, which verifies local/remote history and the
schema marker before publication. Signed Bot inputs, anonymous pulls, topology,
packaged runtime and exact asset digests remain mandatory workflow gates.

No installed-app replacement, new live-provider acceptance, Windows release or
notarization is qualified here. macOS uses the existing ad-hoc signing class.
