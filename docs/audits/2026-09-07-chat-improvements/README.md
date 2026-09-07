# Chat and discovery improvements — 7 September 2026

Implemented the accepted five-item plan in the existing shared UI and web runtime. No dependencies, settings, persisted schemas, public server APIs, or release artifacts were changed by this work. Existing unrelated working-tree changes were preserved.

## Review groups

| Change | Main implementation | Behavior |
| --- | --- | --- |
| Composer history | `packages/ui/src/sync/user-message-history.ts`, `sync-context.tsx` | Store/session-scoped snapshots retain their reference during assistant-only updates and respect local/server revert boundaries. |
| Tool diffs | `packages/ui/src/components/chat/message/parts/toolDiffPreview.ts`, `RawPatchFallback.tsx`, `toolDiffDownload.ts`, `ToolPart.tsx`, `toolPartDiffEntries.ts`, `tool-activity/targets.ts` | Raw-source guards cap previews at 2,000 lines or 262,144 UTF-16 units before whole-source processing. Full downloads preserve source; synthetic writes build the complete patch only on request. Header parsing also observes the budget. |
| Question context | `packages/ui/src/components/chat/message/questionContext.ts`, `MessageBody.tsx`, `lib/turns/projectTurnActivity.ts` | Exact canonical question tools retain one inline explanation, including pending and terminal states; existing plan precedence remains. |
| Clipboard | `packages/ui/src/lib/messages/messageCopyText.ts`, `components/chat/ChatMessage.tsx` | Selected Markdown whitespace and line endings survive copying; shell output/command/text precedence and assistant errors remain. Plan extraction uses its unchanged helper. |
| Discovery | `packages/web/server/lib/opencode/env-runtime.js` | Five-second probe ceilings and ten-second operation budgets, ordered shell deduplication, shared nested WSL budget, forced timeout termination and failed-output rejection. |

The affected codemaps and module documentation describe ownership and contracts. Changes are grouped by the modules above; no commit or publication was requested.

## Verification

- Focused UI regression tests passed, including history, diff boundaries, metadata aliases, generated patches, tool summaries, question states, clipboard extraction, and unchanged plan-card/plan-extraction suites.
- Discovery suite: **17 tests passed**, including simulated Windows paths with spaces, PowerShell/CMD capture, WSL's constrained six-second limit, strict configuration errors, partial-output rejection, and a disposable process that ignores SIGTERM. The process received SIGKILL on its short deadline and was verified absent afterward.
- `node tests/visual-chat-improvements/run.mjs`: **passed**. [Recorded component evidence](component-result.json) includes source hashes, six check groups, counts and cleanup results.
- Across **120 separately flushed assistant updates**, the mounted production `useUserMessageHistory` consumer committed **0 times**, while the broad-store subscription control committed **120 times**. User text changes and directory/session switches updated history; ArrowUp selected the edited prompt without losing the existing draft during streaming. This measures commit counts, not wall-clock latency.
- Instrumented oversized inputs invoked whole-source `split`, `replace`, and `trim` **zero times before download**, and invoked the rich renderer zero times. A deliberately failing rich renderer exercised the real error boundary. Downloaded raw and synthetic patches matched their complete expected bytes, and created URLs were revoked.
- Pending, answered, failed, delayed and similarly named question tools were exercised in Sorted mode; Live context and one-plan-card precedence were checked. Clipboard success and denied-permission fallback used the production extraction and clipboard abstraction with an in-memory browser clipboard endpoint.
- **`bun run validate:full` passed (exit 0), run once.** Workspace lint/type checks and docs validation passed, followed by all deterministic workspace suites, including **3,539 UI tests** and **3,731 web tests**. The docs gate emitted 17 pre-existing historical-reference warnings. The full log is retained at `.cache/qa/chat-improvements-validation-full.log`.
- After final review preserved the old missing-text guard and normal-patch whitespace parsing, **79 targeted regression tests passed** and the component fixture passed again against the final source hashes. Final changed-file lint passed; the final type/doc checks are recorded in [validation evidence](validation.json).

## Visual review

Reviewed all three retained PNGs from the final component run. At desktop and 390px mobile widths, the explanation appears above the question, truncation/download controls precede the bounded scrollable patch, and mobile controls wrap without viewport overflow. The composer retains its edited history selection. The visible “Copy failed” state is the fixture's intentional denied-permission case.

- [Desktop question and patch preview](desktop-preview.png)
- [Mobile question and patch preview](mobile-preview.png)
- [Composer and write/fallback previews](desktop-composer.png)

The fixture uses production components with an isolated synthetic sync context in an Electron Chromium test window. The rich-renderer failure is injected only by its Vite config. It does not connect to a live provider or the installed app. System clipboard access is simulated; the actual patch-download path is exercised. Windows/WSL behavior is tested through injected execution on macOS, not a native Windows installation. Packaged Electron signing, updater, and native-host acceptance were not run.

Early fixture attempts exposed setup-only issues: inherited stale root TypeScript references, development dependency reloads, a background animation-frame wait, and input/screenshot timing. The fixture now has its own TypeScript boundary, deterministic commit flushing, key-up/settling checks and explicit screenshot positioning. Earlier evidence remains under `.cache/qa/chat-improvements-*`; the retained reviewed run above is the final passing source snapshot.
