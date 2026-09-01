# Bot safe retry repair — 2026-08-30

## Status

The retry repair, refusal UI, and diagnostic instrumentation are implemented.
Migration `20260830210000_bot_safe_run_retry.sql` is applied to the linked hosted
DevRyan database; its schema marker was verified. The deployment staging set
excluded the unrelated `20260830180651_bot_audit_clear.sql` migration. No
historical Bot run was requeued and no user conversation or audit was cleared.
The installed `/Applications/DevRyan.app` remains unchanged.

The runtime investigation is **not closed**. Tyrone's original provider error
and Veronica's browser/supervisor failures have not yet been reproduced with
the new instrumentation. No provider, credential, Docker, or timeout adjustment
was guessed. The existing journal reports no gaps, but the original scoped
sessions lack detailed execution records.

## Changes

- Provider retry advice no longer authorizes replay after a handle, prompt,
  output, or action attempt. Historical retry flags also require startup phase
  and no generic or legacy execution identifiers.
- The service-only retry transaction serializes with claims, validates actor,
  current access, active revision, attachments, and scope availability. It
  permits only the unfinalized attachment-free pending admission placeholder
  when execution checks pass, and reuses the existing run and message IDs.
- Existing retry routes/status codes remain. Allowlisted refusal reasons drive
  accurate copy and status refresh, and remove permanent stale retry controls.
  Drafts, attachments, and partial responses remain intact. Timeout and runtime
  unavailability have distinct copy. No automatic resend was added.
- Scoped provider errors are journaled before normalization with bounded
  sanitized text, classification, status, request reference, and run/session
  correlation. Browser recovery and supervisor transport stages include action
  correlation. Headers, response bodies, credentials, and raw transport objects
  are excluded. Bot Audit remains content-free.
- Shared web/Electron contracts remain aligned. VS Code's deliberately
  unsupported Bot presentation is unchanged. Existing unrelated Bot Audit edits
  were preserved; its schema-marker test expectation tracks the new minimum.

## Verification

- `bun run validate:affected` passed (expanded to the full test suite because
  verification scripts changed).
- `bun run type-check` and `bun run lint` passed.
- UI and web builds passed; existing bundle-size warnings remain.
- Isolated local Supabase: 8 files / 499 pgTAP checks passed. This includes real
  message admission, startup retry with unchanged IDs, generic and legacy
  execution rejection, partial output, action attempts, revision/access changes,
  scope contention, valid/expired attachments, and missing attachment mappings.
- Two concurrent database connections: the second retry waited 523 ms for the
  first transaction, then returned `not_retryable`; the run queued once and all
  original message IDs, sequences, and encrypted bodies remained unchanged.
  The dedicated local database was empty before fixture setup and cleaned after.
- Database lint reported no issues in the new retry function. Existing pgTAP
  extension warnings and unused parameters/variables in other functions remain.
- Focused dispatcher, channel, store, provider, browser, route, sanitization,
  Electron transport, and UI tests passed, including provider-transient errors
  after execution and permanent refusal reconciliation against stale status.
- Real-component Electron visual checks passed for permanent retry refusal and
  timeout; both captures were inspected and preserve the partial response.
  Artifacts: `.cache/e2e/bot-retry-repair/`.
- `bun scripts/journal.mjs gaps` returned no gaps. `git diff --check` passed.

## Remaining configured-model acceptance

Both live Bots currently select OpenAI `gpt-5.6-luna`, variant `medium`, and had
no active runs when checked. Do not change those bindings during diagnosis.

Access to `~/.config/openchamber` and a brief stop of the installed app were
requested because AGENTS.md restricts work to the repository and only one
runtime may own the managed data directory. Authorization is still pending.
Do not copy or export the plaintext deployment key; use the normal Electron
safeStorage/in-process callback boundary.

After authorization:

1. Confirm all Bot runs are idle. Stop the installed runtime gracefully and
   start the updated local Electron runtime with the existing configuration and
   OS-sealed key. Do not start competing owners or replace credentials.
2. Use isolated verification conversations with each Bot's configured model.
   Exercise cold startup without a prewarm lease, then explicitly prewarm a
   separate request and verify lease adoption. Never retry an executed run.
3. Require successful text replies and a bounded read of a public page for both
   Bots. Include Tyrone's text case and Veronica's browser case in both startup
   modes. Record new run, session, and action identifiers.
4. Inspect the new `bot.provider.failed`, `bot.browser.recovery`, and
   `bot.action.failed` journal records and rerun gap checks. Make a runtime
   repair only when those records establish the cause; rerun the failed cases.
5. Preserve all original conversations. Clean up only verification-owned
   resources, restore the user's runtime, and do not mark the investigation
   complete until both text and browser acceptance pass.
