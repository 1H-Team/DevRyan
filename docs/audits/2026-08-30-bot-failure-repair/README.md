# Bot failure repair — 2026-08-30

## Status

Implemented and validated locally. Live acceptance is **blocked**, not passed:
the connected hosted database reports schema `20260829130000`; the updated
runtime requires `20260830150000`. Password-free Test Administrator login in
the isolated verification server visibly reached the expected
`migration_required` gate. No synthetic Bot was created, no hosted migration
was applied, and no historical audit or user data was deleted.

Applying the hosted migration requires operator authorization before resuming
the real OAuth/image and human-control acceptance cases below.

## Changes

- Channel-summary commits serialize, refetch/decrypt/rebase on revision
  conflicts, and stop after three bounded attempts. Source-run/logical-key
  duplicates are idempotent; committed summaries can repair their index.
  Decryption failures fail closed. Asynchronous extraction cannot change the
  completed run's outcome; audit counts distinguish partial outcomes.
- Human control creates durable `waiting_control` run/action states before
  execution. Return/expiry resumes the same idempotent attempt; renewed leases,
  cancellation, restart, and repeated lease races have regression coverage.
  Safe remote codes distinguish control, stale-reference, target, generic
  conflict, and transport-uncertainty paths.
- OpenAI ChatGPT OAuth primary agents receive `devryan_image` with the pinned
  plugin's exact schema. API-key/non-OpenAI runs and subagents do not receive
  image permission. New revisions use gateway contract `1.3.0`; `1.2.0`
  revisions and persisted legacy wrapper results remain compatible. Validated
  generated images retain the encrypted assistant-message mapping separately
  from optional Shared publication.

## Verification evidence

| Gate | Result |
| --- | --- |
| `bun run validate:full` | Passed, including repository lint and type checks |
| `bun run build` | Passed; existing bundler warnings remain |
| Memory/action targeted regressions | 31 passed, including retry exhaustion, shutdown, restart, and repeated lease races |
| Isolated local Supabase migrations and pgTAP | 7 files / 471 tests passed; no linked/hosted database writes |
| Docker reasoning/computer images | Both development images rebuilt successfully |
| Docker-backed supervisor tests | 27 passed with the rebuilt images |
| Bot computer package tests | 52 passed |
| Opt-in real Chromium Docker integration | 16 passed, including heartbeat fencing, human input, return, and subsequent agent execution |
| Production Bots visual matrix | 55 scenes passed automated assertions; the five added control/image scenes were also visually inspected |
| Diagnostic journal gap checks | No gaps reported in normal or isolated verification journals |
| `git diff --check` | Passed |

Local visual evidence is under
`.cache/e2e/production-bots-full-final/` (generated
`2026-08-30T15:44:33.550Z`) and
`.cache/e2e/production-bots-control-image-final/`. Captures use the isolated raw
Electron test shell, not a packaged release. They exercise real UI components
with deterministic data and assert decoding/retry, control ownership, keyboard
focus, clipping, console errors, and unhandled rejections. They do **not** prove
a real model generated an image. The capture metadata retains its default
review-pending label; only the five added scenes received manual image review.

The live browser had one WebSocket-close console event during intentional
sign-out. After reload, the migration-gate inspection had no console errors.
No live Bot acceptance interval exists yet because admission was blocked.

## Required remaining acceptance

1. With authorization, apply
   `supabase/migrations/20260830150000_bot_waiting_control.sql` to the connected
   deployment and verify the schema marker. Start the rebuilt runtime and
   record a fresh test-start timestamp; retain all historical audit rows.
2. Using the existing OAuth authorization and a disposable Bot channel, submit
   one low-quality natural-language image request. Verify selection of
   `devryan_image`, successful completion, inline decoding, refresh/reconnect,
   download, and persistence when Shared-copy publication is pending or fails.
3. Hold human control over multiple heartbeats during a Bot action. Verify
   visible waiting, immediate Return Control for the owner, and exactly one
   execution of the resumed attempt.
4. Inspect every new Bot Audit failure since that timestamp and rerun journal
   gap checks. Any unexplained failure, visual defect, console error, or gap
   blocks completion. Local regression evidence does not waive these cases.
