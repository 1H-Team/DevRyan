# Provider requests and usage restoration

This work repairs the shared OpenAI SIWC SSE adapter, the concurrent xAI
credential-refresh race, ordinary Claude account inspection, and optional Codex
usage access. It preserves the selected inference sign-ins.

## Incident evidence

The selected installed runtime's diagnostic journal had no reported gaps in the
examined interval. OpenAI failed before output with a generic Responses stream
read error. xAI failed with `native_credential_changed` before tool or assistant
output. The relevant installed native/plugin sources matched the checked-out
implementation before these repairs. Deterministic tests reproduce the stream
and refresh defects. Their exact contribution to the installed failures remains
unverified by an authenticated UI turn.

An authorized read-only probe used the selected unexpired SIWC token in memory.
Both existing ChatGPT usage and reset-credit endpoints returned HTTP 401 with
`no_matching_rule` after omitting the incorrect subject-as-account header. The
selected credential remained unchanged. No raw body, credential or personal
account identifier is retained here.

## Direct live check

[Sanitized direct-request evidence](live-access-initial.json) records one short
prompt per provider with current access tokens used only in memory and no
refresh. xAI returned HTTP 200, passed the native parser, and completed `OK`.
No allowlisted quota headers or quota events were observed. Both stored
credentials remained unchanged.

The first OpenAI probe discarded its error details. Two separately authorized
follow-ups identified the cause: [HTTP 200 rejected at the SSE header check](live-openai-header-rejection.json),
then [a valid SSE body with a missing Content-Type header](live-openai-format.json).
Replaying those same nine frames with the SSE header in memory completed `OK`
through the native parser. The live response had no allowlisted quota headers or
quota events, and the stored credential remained unchanged. No response text or
credentials were retained.

The shared adapter now accepts an omitted Content-Type while validating SSE
frames and the terminal event; explicit non-SSE types and malformed bodies still
fail. Focused shared-adapter and real native-parser tests exercise this exact
case. This establishes the direct-route header defect and successful parsing of
the live response, but it is not an authenticated web/Electron UI turn.

## Regression coverage

- Shared OpenAI adapter: omitted/case-insensitive SSE content types, supported
  keepalives, split UTF-8/CRLF frames,
  structured terminal errors, completion without EOF, source interruption,
  consumer cancellation, oversized frames and unchanged API-key behavior.
- Native xAI: concurrent title and primary resolutions share one authorized
  refresh; unrelated credential replacement, account switching and revoked
  authorization remain blocked.
- Claude: implicit default, sole shared, explicit multi-profile selection,
  ambiguous/missing/expired accounts and no unintended credential renewal.
- Codex usage: private optional connection, source/account metadata, weekly
  windows, reset inventory semantics, lifecycle and account-cache isolation.

## Renderer acceptance

The isolated [web](web-qa.json) and [Electron](electron-qa.json) runs each passed
all ten checks with the [rebuilt native artifact](native-build.json). Both used
five narrowly scoped synthetic quota requests and checked weekly usage, source
and account identity, reset expiry, unknown inventory and authoritative zero.
The chat journey also verified streaming, typing, send, cancel and reconnect.
There were no unexpected console errors or cleanup failures.

All eight captured screenshots were inspected. Usage figures and account/source
labels are readable without clipping at 1280×800. Available credits show three
resets with expiry; unknown shows unavailable; zero shows no expiry rows. The
final chat view shows completed and cancelled fixture turns and the composer.
Representative views: [web available](web-provider-usage-available.png),
[Electron available](electron-provider-usage-available.png),
[unknown](electron-provider-usage-unknown.png), [zero](electron-provider-usage-zero.png).

Quota fixtures are installed before initial discovery. Electron execution waits
for its isolated native owner; this does not qualify cold-start timing or local
IPC transport. Synthetic checks do not establish live-provider acceptance. No
personal Codex profile was imported and no new login was performed by this audit.

## Validation

- `validate:full` passed workspace lint, type checking and all suites preceding
  the web package (including 4,091 UI tests). Its initial web run failed four
  tests: three bootstrap fixtures missed the concurrently added startup-timing
  import, and one native-process timeout test failed under load.
- The bootstrap fixture now copies its required module. The unchanged
  native-process suite passed in isolation. The complete web package rerun
  passed **6,624 Vitest tests across 541 files**, followed by **14 native Bun
  tests**. No assertions or failure gates were weakened.
- Focused checks passed for the final OpenAI header fix (32 adapter tests and
  19 native-parser tests), safe live-probe diagnostics (5 tests), provider error
  classification (7 tests), and renderer fixture changes (30 tests).
- Final web/Electron build, Electron web-asset staging, changed-file lint and
  bundle budgets passed. Web startup gzip is 1,442,989 bytes against the
  1,456,388-byte budget.
- Small sanitized proof is retained here. All 19 task-owned QA/native build
  directories were removed after preserving evidence; cache report and prune
  preview were run without applying unrelated cleanup.

The final optional usage login lifecycle suite passed all 10 tests, including
queued expiration after approval, stale callbacks and obsolete-profile cleanup
failure. Electron main was rebuilt and changed-file lint rerun afterward.
Documentation validation passed with existing historical warnings.

Live Codex sign-in, an authenticated provider turn through each UI, signed
packaging and physical-device checks remain unperformed.
