# Grok reasoning preview investigation

The reported conversation was inspected in the installed DevRyan interface:
`ses_f5873d23fffe4hvLuuGyxp4gop` (Hide navbar on mobile chat). Its journal had
no gaps. The canonical message API contained the same unfinished text visible
in the interface. Several parts contained a 200-character prefix plus `...`;
others appended a longer summary directly to that prefix.

## Cause and correction

The existing presentation policy suppressed a finalized standalone clipped
preview, but did not recognize a clipped preview followed by a fuller summary.
The shared reasoning formatter now removes that specific prefix and preserves
the following summary, including Markdown. Live and restored history use the
same projection. Canonical messages and encrypted provider metadata are not
changed. Other providers, ordinary ellipses, and different prefix lengths pass
through. Recognition counts Unicode characters with a bounded scan.

This does not recover text the provider never supplies. In a live host test,
xAI's deltas, completed summary, and DevRyan's saved reasoning were exactly the
same 538 characters, ending inside an unfinished Markdown phrase. DevRyan did
not lose the tail. The correction removes the known malformed preview prefix;
provider-side truncation of the subsequent summary remains an upstream limit.
[xAI documents these as reasoning summaries](https://docs.x.ai/developers/model-capabilities/text/reasoning).

## Live verification

Five explicit test requests used `grok-4.6` with Medium effort:

- Direct Responses API, default summary: reproduced the clipped prefix.
- Direct Responses API, `summary: detailed`: reproduced the same prefix.
- Direct Chat Completions API: reproduced the same prefix.
- Isolated DevRyan host, scheduling problem: completed with the exact wire and
  saved-text match above. Outgoing request confirmed `reasoning.effort: medium`.
- Isolated DevRyan host, mobile-navbar scenario: completed with 469 characters
  of ordinary reasoning, including a code fence and cleanup explanation.

The two host tests used a repository-cache workspace, private runtime and
profile, no tools, and no file modifications. Provider headers, credentials,
and encrypted reasoning were excluded from captured stream evidence. Normal
host title generation was auxiliary traffic, not a Medium test result.
The private profile reused installed dependencies without installing any.

The first host admission returned `503 provider_recovery_unavailable` before a
prompt was sent, following a startup readiness failure. The host recovered
through its normal managed restart, after which both identified tests completed.
The user's running app was not restarted or patched.

Local evidence is under `.cache/qa/grok-reasoning-20260916/`: direct API captures,
`wire.ndjson`, projected canonical messages, and `stream-comparison.json`.
The private journal gap check was empty.

## Validation

- Focused reasoning policy and component tests: 35 passed, 0 failed.
- The current formatter was applied to all five recorded live responses. It
  removed the 203-character preview from four responses and preserved the
  ordinary 469-character coding summary exactly. All subsequent text matched
  the canonical remainder; other-provider controls remained unchanged.
- Browser visual acceptance is unavailable: the full isolated app remained in
  runtime readiness recovery, and the separate component replay hit repeated
  computer-use navigation timeouts. These are not counted as visual passes.
- The private runtime and projected credentials were removed after shutdown;
  sanitized journal and stream evidence were retained.
- UI lint, UI type checking, documentation validation, and whitespace checks:
  passed.
- `bun run validate:affected` and `bun run build:web` were stopped after a
  30-minute verification limit. The affected run passed documentation, UI lint
  and UI type checking, then remained in web type checking; it did not reach
  the full UI test suite. The build reported 4,220 transformed modules and third-party warnings
  but did not complete. Neither unfinished command is a pass. Only their owned process
  trees were stopped. The installed DevRyan app has not been replaced.
