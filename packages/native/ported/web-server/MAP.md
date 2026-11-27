# Ported units of `packages/web/server/lib`

Rust ports made with `rust-anything` 5.0.1, one standalone crate per unit (`<unit>-rs/`, each with
its own empty `[workspace]` table, outside the `packages/native` workspace). Units are single
files, bridged with the file's directory as root (crate names join directory and file:
`git-hunk-validation-rs` is `git/hunk-validation.js`). Nothing in the product calls, loads or
ships them; no product or test file changed.

The reference is the server's runtime, Node. Recordings use generated cases plus hand cases
(`hand-inputs.jsonl`); `--from-tests` is not used here (the web suite runs under Vitest, whose
runner spawns workers). A unit is taken only when importing it and calling its ported functions
cannot start a server, open a connection, spawn a process or write files: its import closure
uses no `fs`, `child_process`, `net`, `http(s)`, `os`, timers, `fetch`, `process.env`, clock or
random numbers. Functions that act on `req`/`res`, take callbacks or return closures stay in
JavaScript. Every crate also passes `scripts/rust-anything/error-texts.mjs` (product-built
errors match class and message; `error-sources.json` keeps the throw sites).

22 units done.

| Unit | State | Recorded | Fuzz | JS | Rust | Notes |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| `http-cache-policy.js` | done | 26/26 | 0/0 | 26 | 23 | `shouldDisableHttpCache`; the header writer and middleware act on `req`/`res`. 16 hand cases; UTF-16 prefix compare (a lone surrogate after `/api/` still matches). |
| `legacy-api-path.js` | done | 24/24 | 0/0 | 24 | 22 | `canonicalApiUrl`; the rewrite middleware mutates `req`. 12 hand cases. |
| `runtime-port-visibility.js` | done | 144/144 | 0/0 | 6 | 32 | 40 hand cases. `{ ... } = {}`: an explicit `null` options throws, a primitive does not. |
| `security/forwarded-request.js` | done | 29/29 | 0/0 | 8 | 32 | 17 hand cases. `Object.keys` of a string or array gives index keys, never a match; a `Map` has none. |
| `git/branch-name.js` | done | 23/23 | 0/0 | 45 | 43 | `buildBranchNamePrompt`; `normalizeBranchSlug` needs Unicode NFKD (no crate). An array prompt slices elements and prints them joined. |
| `git/hunk-validation.js` | done | 107/107 | 0/0 | 17 | 113 | 18 hand cases. Product error (`Hunk changed or is unsupported…`) matched exactly (100 throws). Multiline `^` after `\r` and U+2028 too; `test` stringifies a non-string `current` before `search` throws. |
| `git/generation-diagnostics.js` | done | 102/102 | 0/0 | 31 | 97 | 13 hand cases; values pass through as given (`undefined` fields stay keys); `retry`/`scope` test `=== true`. |
| `event-stream/event-dialect.js` | done | 121/121 | 0/0 | 34 | 24 | `applyEventDialect`; `resolveEventDialect` parses `req.url` with the WHATWG URL parser (kept). 32 hand cases. |
| `opencode/anthropic-provider-ids.js` | done | 23/23 | 0/0 | 9 | 22 | 11 hand cases. |
| `quota/utils/transformers.js` | done | 179/179 | 0/0 | 43 | 179 | 5 of 6; `toTimestamp` uses `Date.parse` (V8's date-string heuristics, kept). 117 hand cases. Full JS `Number()`; quirk kept: the window table is a plain object, so `unit: 'constructor'` (or `'toString'`...) gives NaN instead of `null`, and `unit: [3]` finds `3`. |
| `notifications/message.js` | done | 164/164 | 0/0 | 74 | 24 | `truncateNotificationText` (the async summarizer is kept). 60 hand cases; the cut is UTF-16 units and truncates a fractional length. |
| `ui-auth/session-cookie.js` | done | 24/24 | 0/0 | 12 | 30 | `requestUiSessionCookieName`; `uiSessionCookieName` throws a `TypeError` the bindings cannot reproduce (they throw plain `Error`), kept. |
| `orchestration/managed-task-turn-budget.js` | done | 21/21 | 0/0 | 12 | 38 | 9 hand cases. |
| `multi-user/user-profile-visibility.js` | done | 18/18 | 0/0 | 10 | 15 | 6 hand cases. |
| `opencode/tool-output-trim.js` | done | 66/66 | 0/0 | 59 | 96 | 34 hand cases. Product error `toolOutput must be omit` matched; its `statusCode`/`code` properties do not cross the bindings (neither does `git/hunk-validation`'s). `outputBytes` counts a lone surrogate as 3 bytes. |
| `opencode/diff-summary.js` | done | 125/125 | 0/0 | 93 | 129 | All 4 exports; 51 hand cases. A `Map` passes `isRecord` but has no own fields. |
| `opencode/model-default-thinking.js` | done | 193/193 | 0/0 | 68 | 215 | Both exports; 92 hand cases (each SDK adapter family, Azure `gpt-N.M` thresholds). |
| `opencode/openai-model-availability.js` | done | 241/241 | 742/742 | 34 | 125 | `annotateOpenAIModelAvailability` (the async credential read is kept). 33 hand cases. A `null` options object throws only when no auth type is known. |
| `orchestration/required-check-command.js` | done | 60/60 | 0/0 | 52 | 165 | The argv lexer over UTF-16 units; 49 hand cases (quotes, escapes, `&&` edges, env assignments, shell entrypoints by POSIX basename). |
| `event-stream/payload-serialization.js` | done | 229/229 | 1/1 | 44 | 131 | All 3 exports; `JSON.stringify` written out (NaN, `-0`, `undefined`, `Map`/`Set`, `Date`, lone surrogates, BigInt throws); the identity-keyed cache cannot be hit by a recorded call. |
| `multi-user/session-visibility.js` | done | 31/31 | 0/0 | 85 | 87 | `normalizeSessionPageLimit`; the page walker is async over callbacks and the ownership pick sorts with `localeCompare` (kept). Full JS `Number()`. |
| `terminal/terminal-ws-protocol.js` | done | 377/377 | 577/577 | 66 | 106 | The two rebind-rate helpers; the URL and Buffer helpers stay in JavaScript. JS numeric comparisons (`ToNumber`, NaN false). |

Skipped (reason): `http-compression-policy.js` (returns closures), `indexing-policy.js` (registers routes on an app), `security/direct-local-request.js` (WHATWG URL parsing of `Origin`), `tunnels/managed-token.js` (throws a custom `Error` subclass the bindings cannot reproduce), `opencode/session-tree.js` (async client reads), `multi-user/session-visibility.js`'s and `terminal/terminal-ws-protocol.js`'s kept exports as noted, `skills-catalog/curated-sources.js` (constant data copy, nothing to port). Not taken: every file whose import closure reaches `fs`, `child_process`, `net`, `http(s)`, `os`, `ws`, `express`, sqlite or a pty, or that uses `fetch`, timers, `process.env`, the clock or random numbers (most of `opencode/`, `git/`, `fs/`, `multi-user/policy.js`...).

Not attempted yet among the screened-pure files: `opencode/opencode-client/{envelope,errors,location}.js`, `opencode/v2/projection/{ids,status,errors,sessions,tools,catalog,messages}.js`, `event-stream/protocol.js`, `git/commit-message-context.js`, `opencode/notification-settings.js`, `multi-user/{dotenv-visibility,session-folders,managed-agent-defaults,branch-previews}.js`, `opencode/managed-plugins.js`, `terminal/output-replay-buffer.js`.
