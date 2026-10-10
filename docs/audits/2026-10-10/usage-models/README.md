# Provider usage and ChatGPT model list — 2026-10-10

Usage details for Claude, OpenAI, xAI and OpenCode Go disappeared under the
native runtime, and Settings → Providers listed OpenAI models that a Sign in
with ChatGPT account cannot use. Both are fixed in source. **Real-account
behaviour is not yet verified**: the attended sign-in check is still owed.

## Cause

The usage fetchers read `<selected bundle>/global/data/auth.json`. The native
runtime keeps credentials privately in its controller and writes no such file.
On the installed v2.0.5 the selected bundle's `global/data` held only `shell/`,
so OpenAI, xAI and OpenCode Go were never listed by `GET /api/quota/providers`
and never fetched. Claude's fetch already used the native path, but its
discovery still used the file and proxy gate. Only file names, provider ids and
credential `type` fields were inspected; no credential value was read.

## Verification

| Check | Result |
| --- | --- |
| `bun run validate:full` | passed |
| `bun run build` | passed |
| `bun run bundle:check` | passed |
| `bun scripts/build-native-runtime.mjs` and `node scripts/verify-opencode-v2-package.mjs` | passed, manifest `ef585ab8b8198e0a02e2de1dbd0e9a628587781b162caa3f84d25cbaa088a2c7` |
| `node scripts/qa/native-profile-factory-diagnostic.mjs` on that artifact | passed |

The isolated diagnostic starts the actual web host and compiled native
controller in a private profile with no personal accounts. Its new usage case
is recorded in [isolated-usage-discovery.json](isolated-usage-discovery.json):
discovery answered 200, and the new read-only selected-credential read reported
xAI and OpenCode Go as `NOT_CONFIGURED` without listing them. OpenAI was listed
from the fixture's synthetic Sign in with ChatGPT credential; its usage endpoint
is a live service and the diagnostic does not request it.

## Not verified

- Usage numbers for real Claude, OpenAI, xAI and OpenCode Go accounts.
- Whether ChatGPT's usage endpoint accepts a Sign in with ChatGPT token. If it
  refuses, the row shows "Usage is not available with Sign in with ChatGPT."
- An xAI OAuth credential read through the compiled controller. Unit and
  protocol tests cover it; the controller graph test covers only an OpenCode Go
  key.
- The new Settings → Providers states in a browser.
