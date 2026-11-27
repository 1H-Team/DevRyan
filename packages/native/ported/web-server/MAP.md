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

58 units done.

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
| `opencode/opencode-update-runtime.js` | done | 229/229 | 795/795 | 1 | 21 | 18 hand cases (the test's 3 calls included). |
| `opencode/runtime-host/native-managed-job-contract.js` | done | 209/209 | 4916/4916 | 3 | 23 | 9 hand cases. |
| `opencode/runtime-host/native-compaction-policy.js` | done | 74/74 | 0/0 | 7 | 43 | Its test run (10 calls captured); `-0` is a non-negative safe integer. |
| `opencode/runtime-host/native-provider-integrations.js` | done | 57/57 | 0/0 | 8 | 32 | Both validators; 33 hand cases (ID charset, MCP id shape, 1–16 form fields, 1–2048-unit values, NUL). |
| `opencode/v2/managed-title-metadata.js` | done | 43/43 | 0/0 | 19 | 72 | 31 hand cases (each of the 25 fields broken once, extra or missing key, non-canonical directories). |
| `opencode/runtime-host/runtime-bundle-root.js` | done | 326/326 | 4899/4899 | 17 | 74 | `resolveRuntimeBundleRoot`; 277 product refusals (`bundle_recovery_owner_required`) match. Node's POSIX `path.normalize`/`join`; a trailing slash is canonical for an explicit root, `home` is checked only when `XDG_STATE_HOME` is unset. |
| `opencode/opencode-client/envelope.js` | done | 129/129 | 0/0 | 81 | 60 | 4 of 6 (`readResponseBody` is async; `isNoContent` compares with a module sentinel by identity, which no JSON argument can be). 28 product refusals match. |
| `opencode/v2/projection/status.js` | done | 810/810 | 632/632 | 87 | 131 | 6 of 8 (`filterStatusesByDirectory` calls a callback; `reconcileActiveStatuses` tests `instanceof Map` and was not bridged). The test's calls copied in. `activeSessionIDs` returns a `Set`. |
| `terminal/output-replay-buffer.js` | done | 273/273 | 0/0 | 57 | 110 | Create and list; `appendTerminalOutputReplayChunk` mutates its argument (kept). `id > lastSeenId` is the JS relational comparison (`"10" > "9"` is false). |
| `opencode/runtime-helper-agents.js` | done | 2/2 | 0/0 | 43 | 6 | The constant helper-agent definitions. |
| `multi-user/dotenv-visibility.js` | done | 106/106 | 0/0 | 130 | 147 | 3 of 4 (the middleware works on `req`/`res`). Security: 47 threat-model paths plus the test's calls (arrow exports). `decodeURIComponent` written out (strict UTF-8). Reproduced, reported, not changed: single `%2e` encodings, `..%2f.env`, `%00`, NUL, backslash, case and trailing slashes are caught; a double encoding (`%252eenv`), an overlong UTF-8 escape (`%c0%ae`), a fullwidth `．env`, or a `?`/`#` suffix (`.env?x=1`) is not protected, and one malformed escape anywhere (`%zz`, a trailing `%`) leaves the whole path undecoded. A `Map`, `Set` or `Date` value filters to `{}`. |
| `multi-user/managed-agent-defaults.js` | done | 663/663 | 1/1 | 119 | 275 | All 6 exports; 438 hand cases (names with control characters, slashes, 80/81 units; provider/model/variant charsets and lengths, unknown fields including an own `__proto__`, a 1 KiB payload). 348 product refusals match by message. |
| `git/commit-message-context.js` | done | 46/46 | 0/0 | 193 | 54 | `validateCommitMessageSelectedFiles` (the others read Git). 34 product refusals matched by message; path-traversal hand cases (`..`, absolute, backslash, NUL, duplicates). Tests: arrow export; the test's calls copied in. |
| `event-stream/protocol.js` | done | 321/321 | 1/1 | 192 | 354 | 3 of 7: `parseSseEventEnvelope`, `toUpstreamV2SseEvent`, `serializeMessageStreamWsEvent`. The gap-control pair recognizes payloads by `WeakSet` identity and the two senders call socket methods (kept); a recorded (copied) gap payload is an ordinary event, as in JS. `JSON.parse` and `JSON.stringify` written out. 182 hand cases. Tests: `protocol.test.js` run (fake sockets only), 139 calls captured. |
| `opencode/runtime-host/native-provider-deadlines.js` | done | 920/920 | 14632/14632 | 14 | 63 | All 3. Object spread written out (strings by UTF-16 unit, index keys first). The `.d.ts` types `settings` as a record: `rust-anything.json` widens it to `unknown` so an off-type value returned unchanged crosses back as itself. Tests: arrow exports; the test's 16 calls copied in. |
| `opencode/v2/projection/errors.js` | done | 836/836 | 0/0 | 124 | 101 | 3 of 5 (`toV1InterruptError`, `withAbortSource`, `toV2Error`); `v1ErrorNameForV2Type` and `toV1Error` call the optional `isContextOverflow` callback (kept). A `Map` is a record with no fields. Tests: arrow exports; the test's calls copied in, `toV1Error` results written out. |
| `multi-user/branch-previews.js` | done | 53/53 | 0/0 | 283 | 37 | `publicBranchPreview` (security: only the four non-secret fields; rows with secret fields included). `normalizeBranchPreviewUrl` parses a WHATWG URL and the service is a closure over Supabase, vault and `fetch` (kept). Tests: arrow export; the test's call copied in. |
| `opencode/managed-plugins.js` | done | 429/429 | 1/1 | 337 | 189 | 6 of 7; `inspectDevRyanManagedPluginInstallation` reads the caller's `fs` (kept). 266 cases: the test's specs and reconcile lists (extracted from the test as literals) plus spelling variants (backslashes, `file://`, case, NBSP/BOM, lone surrogates, arrays). |
| `opencode/default-plugins.js` | done | 288/288 | 4885/4885 | 396 | 209 | All 3; the managed-plugin lookups as in `managed-plugins-rs`. Quirks kept: an array, `Map` or `Set` options object inherits `entries()` and throws; `findLast` throws on a `null` item it passes. Tests: arrow exports; the test's 3 inventories and 14 lookups extracted as literals, plus 30 hand cases. |
| `opencode/execution-helper-policy.js` | done | 147/147 | 0/0 | 26 | 37 | `isReviewedControllerGitArgs` (security: the controller's Git allowlist). Threat cases: injected `-c`, extra or reordered flags, NUL, lone surrogates, and 27 `refs/remotes/<name>/HEAD` shapes (`..`, `//`, 256/257-unit names, trailing newline, non-ASCII). Tests: none. |
| `opencode/native-verification-order.js` | matches, gate fails | 91/91 | 0/0 | 30 | 38 | `isVerificationCommand`, the regex matched by hand (lookahead on the package-manager branch); 82 hand cases plus the test's 9 commands. `awaitVerificationPublications` awaits callbacks (kept). Gate fails only on `error cases`: it assigns the kept function's `throw` (line 32) to `isVerificationCommand`, which cannot throw (tool problem). |
| `opencode/v2/projection/tools.js` | done | 1832/1832 | 3/3 | 321 | 364 | All 10 exports. "Same reference" returns are the value as given; `{...x}` copies keep key order; strict `!==` across the bindings (objects never equal). 1253 cases: the test's 94 calls (captured by running the test's literal calls through a logging wrapper, see below) plus states, aliases, skill names and contexts. |
| `opencode/v2/projection/sessions.js` | done | 2019/2019 | 580/580 | 1311 | 353 | 14 of 17. Kept: `toV1SessionList` (`slugOf` callback), `sortSessionPage`/`pageV1Sessions` (ICU `localeCompare`). `toV1PathInfo` written out (Node POSIX `dirname`/`join`/`normalize` over UTF-16). A numeric `readOwnedDevryanEntry` key reads its `String()`. The test's 80 calls (vectors included) plus 1235 hand cases. |
| `opencode/v2/projection/catalog.js` | done | 1261/1261 | 747/747 | 859 | 935 | All 21. Security: `redactCredentials` (see below). Quirks kept: the permission config reads `config[permission]` through its prototype, so `constructor`/`toString` rules turn a `*` action into a pattern map and a `__proto__` rule becomes the prototype later keys inherit; `/i` is ASCII-only; `Date#toISOString` (and its `+YYYYYY` years) written out. 455 cases incl. the test's 59. |
| `opencode/v2/projection/messages.js` | done | 869/869 | 3/3 | 1135 | 913 | 14 of 20. Kept: `toV1AssistantInfo`, `toV1CompactionRecords`, `projectMessagePage`, `projectSingleMessage` (hand `errorOptions.isContextOverflow` to `toV1Error`), `fillMessagePage` (async fetchers), `turnSummaryDiffs` (returns a `Map`, which the binary wire cannot carry: tool problem). `toV1AssistantParts` carries `tools.js`'s `toV1ToolPart` and `ids.js`'s cursor part ids in a private module (146 hand cases: cursor and plain assistants, step start/finish, snapshots, reasoning times, tool id rewrites). `userTextSegments` as in `ids-rs`. The test's 47 calls of ported functions plus 351 hand cases. |
| `opencode/runtime-host/native-observation-contract.js` | done | 167/167 | 0/0 | 139 | 97 | `parseNativePresentation` (the 4 re-exports are `shared-runtime`'s). Security: 155 threat cases (each key missing or extra, every id over its charset and 1..256 bounds, digest forms, directory NUL/CR/LF and 4096-unit bound, attempt shape, phase, progress/sequence bounds). Quirk kept: `RegExp#test` reads `String(digest)`, so `["<64 hex>"]` passes. 138 refusals match by message. |
| `opencode/runtime-host/claude-agent-protocol.js` | done | 193/193 | 0/0 | 81 | 267 | Both validators. Security: 169 threat cases (field sets per action, args/env/cwd bounds and charsets, NUL and control characters, base64 canonical form and 16 KiB decode bound, signals, UUIDs, exit code/signal/error, result pairs, the 60 KiB and 8 MiB `JSON.stringify` bounds). 149 product refusals match. `Map`/`Set`/`Date` env objects pass (no own keys), as in JS. |
| `terminal/project-environment.js` | done | 137/137 | 0/0 | 224 | 131 | 2 of 3 (`loadProjectPublicEnvironment` reads files through the caller's API, kept). Security: the credential-suffix patterns against public prefixes (49 keys). Quirks kept: a `__proto__` key defines nothing; a `\r` without `\n` stays inside a line. The test's 19 calls copied in (it writes temp files, not run). |
| `opencode/runtime-host/native-helper-contract.js` | done | 171/171 | 0/0 | 28 | 104 | Both validators. Security: 145 threat cases (unsolicited keys, ids with spaces/DEL, non-canonical directories, coercible session/message ids, prompt byte bounds with lone surrogates, timeouts). A non-string directory throws Node's `TypeError` only after the earlier checks, as in JS. 130 refusals match. The bun test's cases copied in. |
| `opencode/runtime-host/native-managed-job-input.js` | done | 173/173 | 0/0 | 29 | 109 | `nativeManagedJobInput`. Security: 84 cases over each phase's field set, the `cursor-acp` refusal, session/root equality, segment shapes and duplicate jobs. 163 refusals match. |
| `skills-catalog/source.js` | done | 346/346 | 0/0 | 70 | 100 | `parseSkillRepoSource`; its three patterns matched by hand (`\s`, `.`, ASCII `/i`). 242 cases incl. look-alike hosts (`github.com.evil.com`), traversal subpaths and Unicode spaces. |
| `opencode/cli-options.js` | done | 97/97 | 0/0 | 113 | 146 | `parseServeCliOptions` over the caller's `argv`/`env` (nothing read from the process). `parseInt` and `trim` written out; a non-string argument throws as `arg.startsWith` does. 85 hand cases (inline and following values, `--` lookalikes, env fallbacks and truthiness). Tests: `cli-entry-runtime.test.js` stubs it, no calls. |
| `opencode/runtime-host/native-credential-mutation-owner.js` | done | 177/177 | 0/0 | 114 | 172 | `parseCredentialMutationBinding`, `parseCredentialResolutionBinding`; `credentialMutationFingerprint` (SHA-256) and the owner factory are kept. Security: 114 threat cases (kind/valueType/method combinations, delegated and MCP integration ids, create-vs-update fingerprints, MCP server bounds, permit shape and session equality, directory bounds). Quirk kept: `RegExp#test` reads `String(sessionID)`, so an array passes the pattern (then fails the permit's `===`). 138 refusals match by message. Its test run under the guard (39 calls captured). |
Skipped (reason): `http-compression-policy.js` (returns closures), `indexing-policy.js` (registers routes on an app), `security/direct-local-request.js` (WHATWG URL parsing of `Origin`), `tunnels/managed-token.js` (throws a custom `Error` subclass the bindings cannot reproduce), `opencode/session-tree.js` (async client reads), `multi-user/session-visibility.js`'s and `terminal/terminal-ws-protocol.js`'s kept exports as noted, `skills-catalog/curated-sources.js` (constant data copy, nothing to port), `opencode/native-mutation-result.js` (20 dense lines needing Node's `path.resolve`/`relative`: over the 3x size bound), `opencode/startup-timing.js` and `opencode/selection-timing.js` (log to the console, time, `req`/`res`), `opencode/runtime-host/native-retention.js`, `native-owned-requests.js`, `opencode/session-activity-gate.js`, `tunnels/registry.js`, `opencode/native-search-output.js`, `event-stream/canonical-ingestion.js`, `notifications/emitter-runtime.js` (factories returning closures), `opencode/opencode-client/{errors,location}.js` (custom `Error` subclass), `opencode/opencode-generation.js` (calls a client method), `opencode/env-config.js` (WHATWG URL parsing and a logger), `opencode/standard-preview/capabilities.js` and `opencode/runtime-host/native-plan-denial-owner.js` (return `Error` objects; async owners), `opencode/runtime-host/native-shell-completion.js`, `reviewed-document-transform.js`, `native-setup-credential-ack.js` and `native-bundle-credential-contract.js` (SHA-256, no crate), `quota/native-credentials.js`, `startup-notices.js`, `orchestration/provider-reset-probe.js`, `opencode/settings-normalization-runtime.js` (factories over the caller's `os`/`path`/process, or module state). Not taken: every file whose import closure reaches `fs`, `child_process`, `net`, `http(s)`, `os`, `ws`, `express`, sqlite or a pty, or that uses `fetch`, timers, `process.env`, the clock or random numbers (most of `opencode/`, `git/`, `fs/`, `multi-user/policy.js`...).

Not attempted yet among the screened-pure files (candidates for a later batch): `multi-user/policy.js` (role and settings permissions, security), `opencode/runtime-host/native-claude-lifecycle.js` (its parsers; the fingerprints are SHA-256), `opencode/runtime-surface-policy.js`, `opencode/harness-result.js`, `opencode/harness-duplicate-profiles.js`, `opencode/v2/openapi-routes.js` (`openCodeV2RouteKey`, `extractOpenCodeV2Operations`, `renderOpenCodeV2RoutesModule`), `opencode/opencode-routes.js`, `quota/providers/interface.js`. The full per-file state of `packages/web/server/lib` is in the program's `RA-webserver.md` closing summary.

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

`multi-user/dotenv-visibility.js`: 47 threat-model paths plus the test's calls. Reproduced as is
(reported, not fixed): double encoding (`%252eenv`), overlong UTF-8 (`%c0%ae`), a fullwidth dot
(`．env`) and a `?`/`#` suffix (`.env?x`) are not protected; one malformed escape leaves the whole
path undecoded.

`git/commit-message-context.js` (`validateCommitMessageSelectedFiles`): `..` segments, absolute
and drive paths, backslashes, NUL, empty and duplicate entries; every refusal's message matches.

`opencode/execution-helper-policy.js` (`isReviewedControllerGitArgs`): an injected `-c` before or
after the pinned flags, extra, missing or reordered flags, near-miss subcommands, NUL and lone
surrogates, and 27 remote-HEAD refs. Only the listed argument vectors pass; a remote name of 1 to
256 units from `[A-Za-z0-9._/-]` starting alphanumeric, without `..` or `//`, passes
`symbolic-ref`. No bypass found.

`multi-user/branch-previews.js` (`publicBranchPreview`): rows carrying client secrets, vault
references and user ids project only `previewUrl`, `serviceTokenConfigured` (a boolean),
`createdAt` and `updatedAt`.

`opencode/v2/projection/catalog.js` (`redactCredentials`, applied to every settings, options,
headers and environment map): 54 key spellings (`apiKey`, `api_key`, `x-api-key`, `accessToken`,
`client_secret`, `Proxy-Authorization`, `Cookie`, `credentials`, case variants), nested maps,
arrays, and near misses. Reproduced as is (reported, not fixed): a line terminator before the
suffix (`a\ntoken`, `a password`) defeats `.*` and the key is kept; `ſecret`, `api key`,
`api--key`, `cookies`, `set-cookie`, `passwd` and `credentialsFile` are kept; secrets inside
arrays (`[{token}]`) are kept, since only nested records are walked.

`opencode/runtime-host/{native-observation-contract,claude-agent-protocol,native-helper-contract,native-managed-job-input}.js`,
`terminal/project-environment.js`, `skills-catalog/source.js`: threat cases as listed in their
rows. No bypass found beyond the quirks noted there.

Test calls of arrow exports (batch 4): a test file whose calls are literal and which starts and
writes nothing is run under plain Node with a no-op stand-in for `vitest` and the unit's exports
wrapped to log their arguments (scratch outside the repository, deleted after the run); the
logged calls become hand cases. Tests that write files (`project-environment`) or use `bun:test`
fixtures (`native-helper`) had their calls copied by hand instead.
