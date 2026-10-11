# ChatGPT sign-in `additional_tools` role

## Incident

On the installed 2.0.6 replacement build (OpenCode 2.0.26), the first primary
turn after the update failed. Session `ses_ed8a19a46ffewofThT0GqnfIVD` sent the
prompt `test` to `openai/gpt-6-astra` with Sign in with ChatGPT at
19:51 UTC on 10 October 2026. The physical request used HTTP and returned
HTTP 400 after 2.8 s: `provider.invalid-request`,
`Missing required parameter: 'input[1].role'.` The title request for the same
session, which carries no tools, completed. The diagnostic journal reported no
gaps.

This is the request that the [primary transport repair](../../2026-10-10/siwc-primary-transport/README.md)
first allowed to reach the provider. Before that repair the turn was refused
locally at the WebSocket handshake, so the body defect was never sent.

## Cause

The earlier conclusion that the route rejects flat top-level `tools` was inferred
from documentation, not an observed rejection. The October 11 premise replay was
unavailable because the stored access token was expired and the installed turn
failed before refresh. Flat tools will be verified at the isolated built-in sign-in
checkpoint. The shared request encoder in
`packages/web/server/default-config/plugins/devryan-openai-oauth.mjs` previously
moved them into an `additional_tools` input item appended to `input`. It emitted
`{type: "additional_tools", tools}` without a role. The Responses API requires
`role: "developer"` on that item ([tool search guide](https://developers.openai.com/api/docs/guides/tools-tool-search));
without it the item is read as a message and refused. A first turn has one user
message, so the item is `input[1]`, which matches the reported parameter.

Three things hid the defect:

- Every loopback provider fixture accepted a role-less item.
- The live smoke sent a plain prompt without tools.
- Until the transport repair, no tool-bearing SIWC request reached the provider.

## Repair

The encoder gives the generated item `role: "developer"` and applies the same
role to a passed-through `additional_tools` item whose role is missing or
`system`. Tool policy, unsupported-field removal and API-key requests are
unchanged. The native controller and the Bot runtime share this encoder.

The loopback provider fixtures (`controller-integrations.graph-fixture.mjs` and
the Bot `oauth-fixture.mjs`) now answer a role-less item with the provider's
HTTP 400 `missing_required_parameter` error. The live smoke
(`scripts/qa/provider-access-smoke.mjs`) now adds three OpenAI requests built by
the native request encoder: tools offered, a required tool call, and a follow-up
after a tool result.

## Live provider evidence

All requests used the selected SIWC access token in memory, read-only, with no
refresh. The stored credential was unchanged after every request. No response
text, token or account identifier is retained.

Smoke, same four requests before and after the repair:

| Scenario | [Before](live-before-fix.json) | [After](live-after-fix.json) |
| --- | --- | --- |
| Plain prompt, no tools | 200, completed `OK` | 200, completed `OK` |
| Tools offered, answer without using them | 400 refused | 200, completed `OK` |
| Required tool call | 400 refused | 200, completed, requested tool called |
| Follow-up after a tool result | 400 refused | 200, completed `OK` |

[Production body replay](live-production-replay.json): the primary request
bodies that the production composition sends in the provider graph test (14
native tools, instructions, reasoning and cache fields) were captured from the
loopback fixture and replayed against the provider with only the model changed.

- With the role removed, the first-turn body returned HTTP 400
  `missing_required_parameter` for `input[1].role`, the reported failure.
- With the repaired encoder, the first-turn body completed.
- The follow-up body (user message, function call, tool output, tools)
  completed once the fixture's invented function-call ID was omitted. With that
  ID kept, the provider refused `input[1].id`; real IDs come from the provider,
  so this is a fixture artifact and not a runtime defect.

## Deterministic evidence

- Provider graph (`controller-providers.graph.test.ts`), which runs the
  production composition against the stricter fixture: 0 of 3 passed with the
  original encoder, 3 of 3 with the repair.
- Shared encoder tests: 33 passed, including the single-user-message case and
  role normalization for passed-through items.
- Native OpenAI tests: 23 passed. Slim reviewed-resource graph: 1 passed.
  Bot native server tests: 4 passed. Live smoke unit tests: 7 passed, including
  the tool scenarios' wire shape and tool-call recognition.

## Validation

`validate:full` ran with the existing `DEVRYAN_SCRIPT_TEST_CONCURRENCY=2`
setting while the machine was under heavy unrelated load (load average 20 to
35). It is a composed result, not one uninterrupted pass:

- Workspace lint, type checks and documentation validation passed.
- Script tests: all 1,322 Node tests passed. Of the Bun test files, the run
  stopped at `native-interview-owner.test.mjs`, where one test hit its 60 s
  timeout (it took 13 s in earlier runs). That file imports none of the changed
  files. It failed again on an immediate isolated retry and passed on the next
  run. Every other Bun script test file passed, including both provider graph
  suites against the stricter fixture.
- The remaining stages were then run one by one. Visual fixture, all Bot
  packages, shared, harness, orchestration, Cursor, Electron, desktop and UI
  suites passed. The web native stage passed 14 tests.
- Web Vitest: 6,626 of 6,628 passed. The two failures are 5 s timeouts in
  `native-retention.test.js` (the two quiet-delete cases). They failed the same
  way on two isolated retries and on unmodified `HEAD` with this change stashed,
  so they are not caused by this change. They were not seen passing in this
  session; earlier runs on 10 October passed them.
- The native runtime artifact built from this tree (build ID
  `e20897a6c3e471c494aba8c06f06e3317e6baea05244db3f55b9f68faca04e5f`, manifest
  SHA-256 `d4d5b4484b8f2f9ee241bb0d2ec49e9340fd30e155edada382a2297758cb1e98`).
  Its compiled controller contains the developer-role item, and the isolated
  credential-free native factory startup passed.

No assertions or deadlines were changed.

## Not verified

- No turn was sent through the web or Electron UI with the repaired build. The
  installed app still runs the 2.0.6 encoder until a build containing this
  change is installed.
- The Bot Docker OAuth integration (`packages/bots-runtime/opencode/oauth.integration.mjs`)
  was not run; its fixture change is covered only by source review.
- Custom tools, namespace tools and web search were not sent live; the captured
  production body contains function tools only.
- The two `native-retention.test.js` timeouts above have no passing run in this
  session.
