# Ported units of `packages/web/server/lib`

Rust ports made with `rust-anything` 5.0.1, one standalone crate per unit (`<unit>-rs/`, each with
its own empty `[workspace]` table, outside the `packages/native` workspace). Units are single
files, bridged with the file's directory as root (crate names join directory and file:
`git-hunk-validation-rs` is `git/hunk-validation.js`). Nothing in the product calls, loads or
ships them; no product or test file changed.

The reference is the server's runtime, Node. Recordings use generated cases plus hand cases
(`hand-inputs.jsonl`), plus the calls of the unit's own server tests: a test file is run with
`record --from-tests -- node scripts/test-isolation-guard.mjs packages/web/node_modules/.bin/vitest
run --root packages/web <file>` only after reading it (none that starts a server, supertest
included, a process or a connection). `--from-tests` captures only `export function`s; for arrow
exports, and for tests that may not be run, the test's calls are copied into the hand cases. A unit is taken only when importing it and calling its ported functions
cannot start a server, open a connection, spawn a process or write files: its import closure
uses no `fs`, `child_process`, `net`, `http(s)`, `os`, timers, `fetch`, `process.env`, clock or
random numbers. Functions that act on `req`/`res`, take callbacks or return closures stay in
JavaScript. Every crate also passes `scripts/rust-anything/error-texts.mjs` (product-built
errors match class and message; `error-sources.json` keeps the throw sites).

25 units done.

| Unit | State | Recorded | Fuzz | JS | Rust | Notes |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| `http-cache-policy.js` | done | 34/34 | 0/0 | 26 | 23 | `shouldDisableHttpCache`; the header writer and middleware act on `req`/`res`. 16 hand cases; UTF-16 prefix compare (a lone surrogate after `/api/` still matches). Tests: `server/cache-policy.test.js` run, 8 calls captured. |
| `legacy-api-path.js` | done | 30/30 | 0/0 | 24 | 22 | `canonicalApiUrl`; the rewrite middleware mutates `req`. 12 hand cases. Tests: `legacy-api-path.test.js` not run (supertest starts an HTTP server); its 6 `canonicalApiUrl` calls copied in. |
| `runtime-port-visibility.js` | done | 147/147 | 0/0 | 6 | 32 | 40 hand cases. `{ ... } = {}`: an explicit `null` options throws, a primitive does not. Tests: arrow export (not capturable); the test's 3 calls copied in. |
| `security/forwarded-request.js` | done | 227/227 | 0/0 | 8 | 32 | 17 hand cases. `Object.keys` of a string or array gives index keys, never a match; a `Map` has none. Tests: none of its own; 192 threat-model hand cases added (see below). |
| `git/branch-name.js` | done | 24/24 | 0/0 | 45 | 43 | `buildBranchNamePrompt`; `normalizeBranchSlug` needs Unicode NFKD (no crate). An array prompt slices elements and prints them joined. Tests: `git/branch-name.test.js` run, 1 call captured (the others test the kept slug function); `routes.branch-name.test.js` not run (supertest). |
| `git/hunk-validation.js` | done | 107/107 | 0/0 | 17 | 113 | 18 hand cases. Product error (`Hunk changed or is unsupported…`) matched exactly (100 throws). Multiline `^` after `\r` and U+2028 too; `test` stringifies a non-string `current` before `search` throws. Tests: none reference it (its route tests use supertest). |
| `git/generation-diagnostics.js` | done | 108/108 | 0/0 | 31 | 97 | 13 hand cases; values pass through as given (`undefined` fields stay keys); `retry`/`scope` test `=== true`. Tests: arrow export; the test's 6 calls copied in. |
| `event-stream/event-dialect.js` | done | 130/130 | 0/0 | 34 | 24 | `applyEventDialect`; `resolveEventDialect` parses `req.url` with the WHATWG URL parser (kept). 32 hand cases. Tests: `event-dialect.test.js` run, 9 calls captured. |
| `opencode/anthropic-provider-ids.js` | done | 23/23 | 0/0 | 9 | 22 | 11 hand cases. Tests: none. |
| `quota/utils/transformers.js` | done | 179/179 | 0/0 | 43 | 179 | 5 of 6; `toTimestamp` uses `Date.parse` (V8's date-string heuristics, kept). 117 hand cases. Full JS `Number()`; quirk kept: the window table is a plain object, so `unit: 'constructor'` (or `'toString'`...) gives NaN instead of `null`, and `unit: [3]` finds `3`. Tests: none for this file. |
| `notifications/message.js` | done | 165/165 | 0/0 | 74 | 24 | `truncateNotificationText` (the async summarizer is kept). 60 hand cases; the cut is UTF-16 units and truncates a fractional length. Tests: arrow export; the test's call copied in. |
| `ui-auth/session-cookie.js` | done | 56/56 | 0/0 | 12 | 30 | `requestUiSessionCookieName`; `uiSessionCookieName` throws a `TypeError` the bindings cannot reproduce (they throw plain `Error`), kept. Tests: `session-cookie.test.js` not run (spawns a child process); its call and port edge cases copied in, plus threat-model hand cases. |
| `orchestration/managed-task-turn-budget.js` | done | 30/30 | 0/0 | 12 | 38 | 9 hand cases. Tests: arrow export; the test's 9 calls copied in. |
| `multi-user/user-profile-visibility.js` | done | 20/20 | 0/0 | 10 | 15 | 6 hand cases. Tests: `user-profile-visibility.test.js` run, 2 calls captured. |
| `opencode/tool-output-trim.js` | done | 81/81 | 0/0 | 59 | 96 | 34 hand cases. Product error `toolOutput must be omit` matched; its `statusCode`/`code` properties do not cross the bindings (neither does `git/hunk-validation`'s). `outputBytes` counts a lone surrogate as 3 bytes. Tests: `tool-output-trim.test.js` not run (supertest); its 14 calls copied in. |
| `opencode/diff-summary.js` | done | 130/130 | 0/0 | 93 | 129 | All 4 exports; 51 hand cases. A `Map` passes `isRecord` but has no own fields. Tests: arrow exports; 5 calls built from the test's fixtures. |
| `opencode/model-default-thinking.js` | done | 213/213 | 0/0 | 68 | 215 | Both exports; 92 hand cases (each SDK adapter family, Azure `gpt-N.M` thresholds). Tests: `model-default-thinking.test.js` run, 20 calls captured. |
| `opencode/openai-model-availability.js` | done | 242/242 | 742/742 | 34 | 125 | `annotateOpenAIModelAvailability` (the async credential read is kept). 33 hand cases. A `null` options object throws only when no auth type is known. Tests: arrow export; the call of `chatgpt-siwc-contract.test.js` copied in. |
| `orchestration/required-check-command.js` | done | 107/107 | 0/0 | 52 | 165 | The argv lexer over UTF-16 units; 49 hand cases (quotes, escapes, `&&` edges, env assignments, shell entrypoints by POSIX basename). Tests: `required-check-command.test.js` run, 47 calls captured. |
| `event-stream/payload-serialization.js` | done | 293/293 | 1/1 | 44 | 131 | All 3 exports; `JSON.stringify` written out (NaN, `-0`, `undefined`, `Map`/`Set`, `Date`, lone surrogates, BigInt throws); the identity-keyed cache cannot be hit by a recorded call. Tests: arrow exports; the test's 8 payloads x options copied in (64 calls). |
| `multi-user/session-visibility.js` | done | 34/34 | 0/0 | 85 | 87 | `normalizeSessionPageLimit`; the page walker is async over callbacks and the ownership pick sorts with `localeCompare` (kept). Full JS `Number()`. Tests: arrow export; the test's 3 calls copied in. |
| `terminal/terminal-ws-protocol.js` | done | 382/382 | 577/577 | 66 | 106 | The two rebind-rate helpers; the URL and Buffer helpers stay in JavaScript. JS numeric comparisons (`ToNumber`, NaN false). Tests: arrow exports; the test's 5 calls copied in. |

| `opencode/v2/projection/ids.js` | done | 3782/3782 | 60551/60551 | 250 | 329 | All 18 exports (JSDoc types give fuzz generators). 407 hand cases, the test's calls included (arrow exports). Template ids print with `String()` (arrays joined, lone surrogates kept); per-kind ordinals; Cursor part ids only on marked rows and at most 256 units; descriptor `length` must be a safe integer (`-0` passes). |
| `opencode/notification-settings.js` | done | 172/172 | 0/0 | 63 | 91 | 68 hand cases (the test's 2 calls included). The two legacy completion templates count as unset. |
| `multi-user/session-folders.js` | done | 56/56 | 0/0 | 90 | 286 | Both exports; 43 product refusals matched by message (`statusCode` does not cross). Checks in the source's order; `Number(null)` and `Number("")` are 0, so a `null`/empty `createdAt` passes; duplicate collapsed ids dedupe in order. The test's 3 calls copied in. |
Skipped (reason): `http-compression-policy.js` (returns closures), `indexing-policy.js` (registers routes on an app), `security/direct-local-request.js` (WHATWG URL parsing of `Origin`), `tunnels/managed-token.js` (throws a custom `Error` subclass the bindings cannot reproduce), `opencode/session-tree.js` (async client reads), `multi-user/session-visibility.js`'s and `terminal/terminal-ws-protocol.js`'s kept exports as noted, `skills-catalog/curated-sources.js` (constant data copy, nothing to port). Not taken: every file whose import closure reaches `fs`, `child_process`, `net`, `http(s)`, `os`, `ws`, `express`, sqlite or a pty, or that uses `fetch`, timers, `process.env`, the clock or random numbers (most of `opencode/`, `git/`, `fs/`, `multi-user/policy.js`...).

Not attempted yet among the screened-pure files: `opencode/opencode-client/{envelope,errors,location}.js`, `opencode/v2/projection/{status,errors,sessions,tools,catalog,messages}.js`, `event-stream/protocol.js`, `git/commit-message-context.js`, `multi-user/{dotenv-visibility,managed-agent-defaults,branch-previews}.js`, `opencode/managed-plugins.js`, `terminal/output-replay-buffer.js`.

## Security units: threat-model cases

`security/forwarded-request.js` (`hasForwardingHeaders`): 192 hand cases over 32 header names x 6
values (comma-joined and array-valued repeats, empty, `null`, an RFC 7239 IPv6 `for=` value), plus
`rawHeaders`-only, array/index-keyed `headers`, and two spellings of one name. Covered elsewhere
before: only the lowercase canonical names (`x-forwarded-for/host/port/proto`, `forwarded`,
`cf-connecting-ip`, `cf-ray`), through `tunnels/access-control` and `multi-user/supabase-connection`
tests. Behaviour reproduced as is (not changed, reported): names are matched after
`toLowerCase`, so case variants count; `x_forwarded_for` (underscore), `x-real-ip`,
`true-client-ip`, `x-client-ip`, `via` and `x-original-forwarded-for` are not forwarding headers to
it; an `x-forwarded-*` or `cf-*` name with trailing junk (a NUL) still matches by prefix, while `forwarded` must match exactly (`forwarded `, ` forwarded`, `forwarded-for` do not); only `req.headers` is read, never
`rawHeaders`; a Unicode lowercase that yields ASCII (`\u212A-forwarded-for` -> `k-...`) does not.

`ui-auth/session-cookie.js` (`requestUiSessionCookieName`): the test's forged-Host request, its
port list (0, -1, NaN, 65536, `'3001'`), and 24 more ports (`1`, `65535`, `3001.5`, `1e21`,
infinities, `-0`, `true`, `[3001]`, `{valueOf}`, `' 3001'`, hex text, 2^53) with spoofed `Host`,
`X-Forwarded-Port` and `Forwarded`, plus missing, non-object and `Map` sockets and
`connection.localPort`. Only an integer `socket.localPort` in 1..65535 names the cookie; headers
never do. Cookie attribute and encoding cases do not apply here: the unit only builds the name;
parsing the `Cookie` header lives in `security/request-security.js` (not ported: its closure
reaches the clock and crypto).
