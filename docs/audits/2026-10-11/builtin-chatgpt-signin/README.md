# Built-in ChatGPT sign-in migration

Working-tree migration to OpenCode 2.0.26 `opencode.provider.chatgpt` /
`chatgpt-token-sharing`. No commit, push or release is part of this work.

## Scope

Desktop/web uses the native automatic OAuth callback, native model list and
unmodified Responses body/stream. The host retains direct-local admin admission,
serialized credential resolution/refresh, selected-account proof and exact route
checks. Stored SIWC, browser and headless logins require a new sign-in.
API-key Bots remain supported; OAuth Bots/managed users fail with the existing
401 reconnect code until the follow-up pass. The Node coordinator and Bot wire
plugin remain for the follow-up pass; unused SIWC enrollment and account model
cache modules have been removed. The user waived the attended deletion gate.

## Premise check

Step 0 was unavailable: the token was expired and the installed user turn
`ses_ed8a19a46ffewofThT0GqnfIVD` failed before renewal with
`native_openai_location_unavailable`. The replay made no provider request. The
journal gap check found no gaps. The user authorized continuing and checking
flat tools at the isolated live checkpoint. No live acceptance claim is made.

## Verification

Controller unit tests prove scoped versus unscoped resolution, reviewed method
registration, refresh-only write-back, retirement/removal, permit proof and
byte-identical request bodies. Backend tests cover generic polling/cancellation,
route admission, metadata reads and API-key image behavior. The graph fixture
uses the real built-in authorization callback and signed fixture ID token.
All three transport graph variants (unspecified, HTTP and requested WebSocket)
passed: the real built-in callback, flat top-level tools, a native tool-result
round trip, HTTP Responses, zero WebSocket upgrades, and exactly one refresh
shared by overlapping title/primary resolutions. The provider catalog graph
and retired SIWC/browser cold-start fixture also passed.

The initial held UI could not load its default provider catalog because the QA
profile had no default workspace in its web-data settings. Its journal had zero
gaps; explicit reviewed-workspace requests succeeded. Seeding the isolated
web-data settings fixed both default provider routes. This is a QA-profile fix,
not a relaxation of runtime location checks.

The compiled native bundle and isolated factory/startup diagnostic passed with a
retired SIWC row, both default provider routes available and no cleanup failures.
The [sanitized startup result](native-startup.json) records the exact bundle
identity and limits its claim to synthetic startup; it made no real provider
requests. Temporary bundles and superseded diagnostic runs were removed.

| Deterministic check | Result |
| --- | --- |
| Focused controller, facade, authorization, provider, quota, Bot and UI suites | Passed |
| Three provider transport graphs and retired cold-start graph | Passed |
| Web/Electron build and bundle budgets | Passed |
| Native bundle and isolated startup diagnostic | Passed |
| Documentation validation | Passed, existing historical/generated-link warnings |
| Storage report and cleanup preview | Passed; unrelated artifacts retained |
| `DEVRYAN_SCRIPT_TEST_CONCURRENCY=2 bun run validate:full` | Failed: existing interview service/UI/answer worker case timed out after 60 seconds; focused rerun reproduced the timeout |

The broader integration graph initially raced assistant completion against
runner permit release. It now waits for native idle before starting the next
operation; its unchanged provider/permit assertions passed on the focused rerun.
One later aggregate run timed out waiting for a second-location prompt in the
omitted-transport variant, while the other two variants passed. Its focused
rerun passed. The second prompt now uses the same 20-second bounded wait as the
first and explicitly rejects an assistant error; variant diagnostics are kept
separately so subsequent cases cannot overwrite failure evidence.
Notification, interruption and Slim resource graph consumers were updated for
the changed native fixture. Controlled revocation/interruption cases use their
own primary hold and explicit titles, keeping detached title cancellation out
of those cases; the Slim responder uses flat tools and native argument deltas.
All six focused cases passed with their authority and resource assertions intact.
The Bot image fixture retains API-key transport/path/cancellation checks and
now proves OAuth refusal without traffic or output publication. The credential
worker suite passed all 15 cases on its focused rerun. Full validation is not
claimed green; the unrelated interview worker timeout remains unresolved.
The separate workspace run also timed out in the unchanged harness
`identical-content re-stamps install in large batches while content changes keep
small batches` case after 120 seconds, followed by `capture_git_failed` during
test termination. These broader failures have not been suppressed or counted
as successful verification.
The already-failed harness run was interrupted during its remaining filesystem
cases to reduce contention with the build/backend checks; it is not a pass.
The full UI run passed 4,092 cases and failed the two new action labels' casing
and a JSX source-scan deadline. The labels were corrected to `Sign In` and
`Cancel Sign-In`. After the build settled, all 32 focused provider UI/copy tests
passed, including the unchanged five-second JSX scan (2.19 seconds). The final
web/Electron build completed and bundle budgets passed. The broader web run hit default
five-second deadlines in unchanged retention/profile-factory cases and was
interrupted after those failures. Neither broad run is counted as passed.

The user subsequently asked to skip login and complete the implementation.
No real consent, provider request, live tool round trip, disconnect/re-login, or
role fallback was verified. Flat-tools acceptance is proved against the native
fixture only; acceptance by OpenAI is still unverified.

## Known limits

Browser consent requires the user. The fixed native model list omits
`gpt-5.4-mini`; role fallback must be checked live. An interrupted rotating-token
refresh can require sign-in again. No account email is displayed; Disconnect
does not revoke the OpenAI grant.
