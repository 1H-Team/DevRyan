# v2.0.6 replacement release qualification

The replacement includes the [ChatGPT primary transport repair](../siwc-primary-transport/README.md)
and all original v2.0.6 changes. The original release and verification commits
are combined with the pending changes into `release v2.0.6`.

Fresh web/Electron build and bundle budgets passed. The native runtime rebuilt
with build ID `366f0a926f47df7d8ea27c3612b3c49ffe5bb5980249a392b4ffde0a3121bbf7`
and manifest SHA-256 `460dae0edceac01d0b9104ca508b9c721ae3c4a7ceb8d4676cefc1700cdec223`.

[Electron chat QA](qa-electron.json) passed seven checks.
[Readiness-gated web QA](qa-web.json) passed ten checks including usage source,
weekly windows, unknown inventory and zero inventory. Final
[web](web-chat-idle.png) and [Electron](electron-chat-idle.png) chat screenshots
were visually inspected. All runtime payloads were private; no live provider
inference or installed-app credential integration was exercised.

Earlier web attempts remain explicit: the [ordinary chat run](initial-web-failure.json)
passed its interactions but failed its console gate on bootstrap requests for
unreviewed root/HOME directories. The first readiness-gated run
[timed out after reconnect](web-reconnect-timeout.json). The subsequent
readiness-gated run passed without changing assertions or deadlines.

No Supabase source files changed since the original release. Hosted migration
deployment and exact release asset verification use the existing GitHub
workflows. The desktop scope publishes only `DevRyan-2.0.6-arm64.dmg`.
The release title is `DevRyanv2.0.6`.

Full validation passed in one invocation with the existing
`DEVRYAN_SCRIPT_TEST_CONCURRENCY=2` setting: workspace lint, type checks,
documentation validation and all deterministic test stages, including 4,091 UI
tests, 6,626 web Vitest tests and 14 native web tests. Documentation validation
also passed after adding this qualification record.
