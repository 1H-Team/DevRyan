# Session archive investigation

## Confirmed recovered-input archive failure

The subsequent report supplied `archive failed (409):
native_recovered_input_fenced`. The selected live bundle was revision 9,
`native-a83a2b8d915c11f87aa2fd65-r8`, with artifact manifest SHA-256
`a83a2b8d915c11f87aa2fd65b57ee6a8d8407b3545a84078f91c33df665efb2f`.
Its native controller PID was 2683 and execution supervisor PID was 2674.

The selected bundle's journal contains two `session_archive_failed` records
for `ses_ed8a19a46ffewofThT0GqnfIVD`, at 2026-10-11 09:45:12.704 UTC and
09:45:46.578 UTC. Both record action `archive`, HTTP 409 and
`native_recovered_input_fenced`. The selected journal's `gaps --verify` check
reported no gaps. Read-only inspection found two persisted user messages, one
assistant message, an empty inbox and an observing recovery record without a
started step. No message content or credentials were copied.

The recovered-input owner fenced the generic `web.operation` permit before
the archive metadata write. The archive facade only changes visibility metadata,
but its permit was treated like a mutation that could consume recovered input.
Earlier empty/completed-session tests did not exercise this state.

The admission owner now validates the exact archive-only metadata replacement
against its existing private metadata reader before issuing a scoped permit.
The recovered-input fence accepts that permit only for its web wrapper and
`session.setMetadata` effect. Exact payload checks, fresh authorization, holds
and revision checks still apply. Archive/unarchive neither discards nor resumes
retained input. Other metadata, prompts and execution remain protected.

New composed regressions cover queued and promoted recovered input, archive and
unarchive, retained input and metadata preservation, changed payloads, other
operations and revoked authorization. The targeted recovery and authorization
suites passed all 29 tests. [Native acceptance](recovered-input-native-verification.json)
passed all 49 cases with an unchanged source snapshot and clean process shutdown.
The web package suite passed 6,582 Vitest tests and 14 Bun native tests. The
harness suite passed 703 tests (10,670 assertions). Workspace lint and type checks passed.
Full validation stopped at an unrelated uncited `startup-speed` audit
directory created by concurrent work; documentation validation passed after that
concurrent work resolved the citation. The complete workspace test suite has not
been rerun.

This diagnoses the later typed failure; it does not retroactively identify the
earlier unrecorded rejection below. The running app and its chats were not changed.

The reported symptom is an immediate sidebar removal followed by restoration
and “Failed to archive session.” The UI intentionally restores a session when
its archive request fails. The single-session handler discarded the structured
failure explanation; it now retains the same explanation used by bulk archive.
The worktree dialog uses the structured result as well.

## Live evidence

- Inspected the active runtime selected at revision 8, bundle
  `native-fc698c11522c43d1e729ab2b-r7`, running OpenCode 2.0.26.
- The diagnostic status and `journal.mjs gaps --verify` reported no gaps. The
  journal and retained desktop/controller logs did not contain the reported
  archive rejection. The old archive route did not journal its failures.
- A deliberately invalid archive timestamp was rejected by the expected live
  archive handler with HTTP 400 and `opencode_invalid_input`, before mutation.
- With the user's explicit permission, created one disposable diagnostic chat
  without sending a prompt. HTTP archive/unarchive succeeded. Both the live web
  UI (including a selected chat) and Electron archive button also succeeded;
  an authoritative session read confirmed the archive timestamp.
- These successful checks do not establish the cause of the original failure.
  The disposable chat is retained archived; no existing user chat was mutated.
- The user subsequently reported that their existing chats archive successfully.
  This investigation did not deploy code or restart the running application,
  so that recovery cannot be attributed to these source edits.

## Root-cause assessment

The original archive rejection is unclassified because the response was not
retained. A transient request/runtime failure is consistent with recovery, but
there is no evidence to select a specific error code or subsystem.

The confirmed diagnostic defects are the single-session UI's discarded failure
details and the server archive route's missing journal failure record. Both are
corrected. Failed optimistic mutations still restore the chat; removing that
rollback would hide an unsuccessful archive.

Cold cache state does not explain the failure: archive reads the session before
writing, native authorization resolves its lineage independently, and the
composed local-authorization test succeeds without prior session reads. A stale
disconnected flag alone does not explain the visible flicker either, because
connection checks precede optimistic removal. New session events do not replace
the UI SDK. No additional retry, authorization bypass or speculative state
reset was introduced.

## Changes and checks

- Single-session archive errors retain their structured explanation. Mounted
  tests cover direct and confirmed actions, failed callbacks and no deletion.
- The archive route records `session_archive_failed` with session ID, action,
  bounded machine code and HTTP status. It excludes raw error text, paths,
  metadata and transcript content.
- Local-owner authorization coverage exercises archive/unarchive through the
  request context, native admission and session lock, including grant revocation.
- [Native verification](native-verification.json) records the real native
  archive/unarchive journey before and after a completed simulated provider/tool
  turn. All 49 native acceptance cases passed, with clean process shutdown.

Workspace lint, type checks and documentation validation passed. Full validation
stopped in the unrelated `UsageProviderPanel.test.tsx` quota-panel test: it
expected “Usage source: Codex” but rendered the untranslated
`settings.providers.codexUsage.source` key. Concurrent provider-settings edits
are outside this archive change; the full suite is not a pass.

The two mounted archive-action regressions passed separately (13 assertions).
The route and native-authorization suites completed with 102 passing tests,
including archive coverage, and one unrelated failure in “uses only native
metadata for chatgpt-browser availability” (expected unavailable-model metadata
was absent). All 11 native-authorization tests passed.
No installed application was replaced.

## Follow-up: validation failures corrected

Restored the four usage-panel labels still consumed after the optional
connection UI was removed. Updated the provider-route expectation to accept
the existing `chatgpt-browser` catalog behavior while retaining refusal checks
for the other legacy methods. All 7 usage-panel tests and all 92 provider-route
tests now pass. Workspace lint passed. The quick validator expanded to full
validation because of other pending changes; that rerun was stopped, so full
workspace validation remains incomplete.
