# Native Codex sign-in for chat and usage

The user authorized testing OpenCode's native legacy Codex browser flow in an
isolated profile, then switching to it and removing the separate usage sign-in
if chat and usage worked. No installed application, selected credential or
personal profile was changed. No commit, push or release is authorized.

## Live evidence

OpenCode 2.0.26's real `chatgpt-browser` automatic enrollment completed after
browser consent. Its HTTP chat returned the requested probe answer. A read-only
`GET https://chatgpt.com/backend-api/wham/usage`, with the selected bearer and
actual stored account ID, returned **200** with **one recognized allowance
window**. The weekly figure was not verified. The credential, runtime home and
database were disposable and removed after the probe. Only the
[sanitized result](live-result.json) is retained: no token, account identifier,
usage percentage or response body.

The original probe required two windows and therefore recorded `usage: failed`
and `AssertionError` despite HTTP 200 and one valid allowance window. That
original result is preserved unchanged. The subsequent probe contract accepts
one or more valid windows and separately records weekly presence; it has not
been rerun against OpenAI. No all-window live pass is claimed.

The first consent attempt failed a selection assertion before chat or usage:
internal `Credential.Info` has no `active` field. Cleanup removed that credential;
the corrected second attempt supplies the evidence above.

The [earlier token-sharing investigation](../builtin-chatgpt-usage/README.md)
returned usage 401 `no_matching_rule`. The user-authorized pinned OpenChamber
inspection established that its usage fetcher reuses the selected Codex token
and its sign-in surface exposes native legacy methods. No upstream checkout,
OpenChamber runtime or personal account profile was launched.

## Implementation

- New enrollment exposes native **Codex browser (legacy)** and API key. Existing
  token-sharing rows keep chat access. SIWC/headless rows and mislabeled browser
  rows with token-sharing client metadata stay unavailable and removable.
- Reviewed OpenCode registrations own enrollment, encoding, parsing and refresh.
  Refresh uses the host's serialized resolution commit. Admission, selected
  permit proof, exact HTTP route, bearer and actual account checks remain.
  Prepared WebSockets are stripped and OAuth physical upgrades are refused.
- Usage verifies selected metadata against the private owner read and passes
  only access/account fields to the existing fetcher, without refresh. Usage
  and reset reads reject redirects and bound time/body size; expired native
  access asks for the next OpenAI request, without another login. Opaque
  connection identity invalidates old readings. Missing windows are omitted.
- Separate usage enrollment UI, routes and app-server helpers are deleted.
  Old private usage profiles are left untouched and never imported. Bots,
  managed-user inference and images still require an OpenAI API key.

## Verification

The real native controller graph passed with Codex enrollment, HTTP primary,
title, compaction and generation, account switching, and one refresh shared by
concurrent primary/title requests. Provider variants passed for omitted, HTTP
and WebSocket-prepared configuration, including a native tool round trip and
zero WebSocket upgrades. Focused quota, facade, credential and UI suites cover
selection mismatch, no refresh forwarding, removed routes, polling/cancel,
account invalidation and native usage source parsing.

Web/Electron build and sealed native artifact build passed. The actual isolated
web host and native controller startup passed with a retired SIWC seed, usable
provider catalogs, and no-account usage discovery; see the
[sanitized startup result](startup-result.json). Runtime payload cleanup completed
without failures. `DEVRYAN_SCRIPT_TEST_CONCURRENCY=2 bun run validate:full`
passed, including 4,095 UI tests, 6,577 web Vitest tests and the final 14 native
backend tests. `bun run bundle:check` and `bun run docs:validate` also passed.
The initial full runs exposed stale graph expectations for the Codex context
budget and the Stop fixture's transport hook; both fixtures were corrected and
the complete run passed. Owned probe/runtime payloads and the sealed artifact
were removed; the final cache report was within the repository's storage budget.

Live multi-step tools, the full DevRyan UI journey, Disconnect / second sign-in,
model-role coverage and weekly allowance remain unverified.
