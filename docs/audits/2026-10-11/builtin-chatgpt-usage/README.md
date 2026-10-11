# Built-in ChatGPT read-only usage check

The user authorized one read-only check using the current built-in ChatGPT
sign-in, and removal of the separate usage sign-in only if it succeeded.

The selected runtime's single active OpenAI credential was
`chatgpt-token-sharing` and unexpired. Its access token was used only in memory
for one `GET https://chatgpt.com/backend-api/wham/usage`, with manual redirect
refusal, a 20-second timeout and a 64-KiB response bound. No refresh, enrollment,
inference, account-header guess or credential mutation was performed.

The endpoint returned HTTP **401** with **`no_matching_rule`**. The credential
and runtime selector were unchanged after the request. No token, response body,
account identity or usage figures are retained. The
[sanitized result](result.json) records the check at 2026-10-11 07:05:38 UTC.

The separate usage sign-in remains: the condition for its removal was not met.
This result concerns this credential and endpoint at the recorded time; it does
not establish that every future ChatGPT token-sharing usage route will refuse.
Reset-credit access and a separate Codex login were not tested in this check.

## OpenChamber comparison

The user subsequently authorized inspecting upstream OpenChamber. The current
`main` commit inspected was `09494f3db599b9c81e0eecea86ba16e75cecf362`
(2026-10-11 00:00:15 UTC), using OpenCode client/schema 2.0.26.

Its [usage provider](https://github.com/openchamber/openchamber/blob/09494f3db599b9c81e0eecea86ba16e75cecf362/packages/web/server/lib/quota/providers/codex.js)
reads the selected OpenAI OAuth token, calls the same `/backend-api/wham/usage`
endpoint with `Authorization` and `Content-Type: application/json`, and adds a
`ChatGPT-Account-Id` header only when stored metadata supplies one. Its
[credential projection](https://github.com/openchamber/openchamber/blob/09494f3db599b9c81e0eecea86ba16e75cecf362/packages/web/server/lib/opencode/auth.js)
maps `metadata.accountID` to that header. Neither path checks whether the login
method can use the usage endpoint. The provider describes every HTTP 401 as an
expired session; that message does not prove the token is expired or that a
fresh token-sharing login would work.

A second authorized, read-only request reproduced these request headers with
the current built-in credential. No account ID was present, so no account
header was invented. The token was unexpired; the response again returned
**401 `no_matching_rule`**, with the credential and selector unchanged. The
[OpenChamber-shaped result](openchamber-result.json) retains only safe fields.
No OpenChamber runtime or personal profile was launched or modified.

There is no alternate usage endpoint or token exchange in that upstream usage
path to reuse. Its absence of a second sign-in does not establish successful
usage reporting with the current token-sharing grant. The optional connection
remains; viewing [ChatGPT Settings → Usage](https://chatgpt.com/#settings/Usage)
is an alternative without another DevRyan connection, but does not populate
DevRyan's usage figures.

## Sign-in choices and plan allowance

The user clarified that the requested figures are ChatGPT's 5-hour and weekly
plan allowance. OpenChamber's
[method selection](https://github.com/openchamber/openchamber/blob/09494f3db599b9c81e0eecea86ba16e75cecf362/packages/ui/src/components/sections/providers/providerAuth.ts)
includes every OAuth or external method in the native catalog, and its
[sign-in component](https://github.com/openchamber/openchamber/blob/09494f3db599b9c81e0eecea86ba16e75cecf362/packages/ui/src/components/sections/providers/ProviderOAuthMethods.tsx)
renders their supplied labels. It does not hide the legacy Codex methods.

OpenCode 2.0.26 registers `chatgpt-browser` ("Codex browser (legacy)") and
`chatgpt-headless` ("Codex device code (legacy)") separately from
`chatgpt-token-sharing` ("Sign in with ChatGPT"). The legacy provider uses
`https://chatgpt.com/backend-api/codex` and stores an account ID when available;
the token-sharing provider requests `chatgpt.tokens.use.direct` for
`https://api.openai.com/v1` and stores client/scopes metadata. These are distinct
OAuth flows, even when the human signs into the same ChatGPT account.

OpenChamber's usage provider maps `primary_window` and `secondary_window` by
their duration to the displayed 5-hour and weekly allowance. Its reuse of the
selected credential explains how one legacy Codex sign-in can serve chat and
usage, and is consistent with the user's recollection. The inspected source
does not prove that a current token-sharing sign-in can do so; both authorized
checks of the user's current credential failed.

OpenChamber's separate
[OpenCode Go provider](https://github.com/openchamber/openchamber/blob/09494f3db599b9c81e0eecea86ba16e75cecf362/packages/web/server/lib/quota/providers/opencode-go.js)
reads OpenCode's own allowance, not ChatGPT's allowance.

A possible one-connection alternative is to use the native legacy Codex flow
for chat and usage. That would reverse the migration's explicit decision to
hide/refuse legacy methods and change the chat route. No legacy enrollment,
chat/model compatibility check or successful legacy usage read was performed
in this investigation. The working token-sharing sign-in was not changed, and
the optional usage connection was not removed.

## Subsequent decision

The user authorized a separate isolated native Codex enrollment and a switch
only after checking chat and usage. That probe passed chat and returned usage
HTTP 200 with one recognized allowance window. The separate usage sign-in has
therefore been removed in the working tree; the conclusions above remain the
historical token-sharing investigation. See the
[native Codex audit](../native-codex-signin/README.md).
