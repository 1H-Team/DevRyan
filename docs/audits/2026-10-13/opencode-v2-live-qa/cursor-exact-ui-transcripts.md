# Exact native Cursor UI transcripts

14 October 2026. The native Cursor adapter and v2 event projection retained two
legitimate repeated Markdown lines, but completion normalization reduced their
96 UTF-8 bytes to 48 in UI state. Reload normalization had the same behavior.

The UI now recognizes the existing constructor-owned Cursor part identity in
provider state. Exact text and reasoning bypass legacy string deduplication and
content-based diagnostic/status cleanup. Cumulative snapshots can correct shorter
prefixes; an unfinished historical response cannot replace completed live text.
Distinct repeated parts and whitespace seams survive rendering and message copy.
No transport fields were added, and typed tool/diagnostic structure is preserved.

The owning regression uses the actual v2 event projector, SSE payload serializer,
UI reducer, REST message projection, loader normalization, materialization,
render-part merge and message-copy function. It proves the same 96 bytes during
busy state, completion, reload and copy, plus Unicode, CRLF, Markdown, whitespace
seams, reasoning, removed parts and shorter cumulative corrections.

Focused legacy/owning tests passed 85 tests, then 117 reducer/materialization/
pending tests. The final correction cohort passed 101 tests, including eight
connected transcript cases. UI TypeScript and focused ESLint passed. These are
deterministic contracts; no live Cursor provider or rebuilt installed-app result
is claimed. Root owns the subsequent web build and full validation.

```text
cd packages/ui
bun test src/sync/native-cursor-transcript.test.js src/sync/__tests__/materialization.test.ts src/sync/__tests__/event-reducer.test.ts src/sync/__tests__/event-reducer.test.js
```
