# Bot upgrade implementation and verification

Implementation is integrated in the working tree. **This is not a production
release sign-off.** No production migration, real Telegram pairing, provider
credential configuration or release was performed. Existing uncommitted work
and selected reasoning models were preserved; no application dependencies were added.

The local journal index and gap report were inspected. The gap command emitted
no gap entries, but no session/message identifier was supplied for the reported
conversation. The fixes are supported by reproduced defects and regression
tests; they do not establish the cause of that particular conversation's output.

## Implemented behavior

- Verified final-only replies preserve authoritative request/part identity and
  visibility. Reasoning, unknown fragments, acknowledgments and pre-tool prose
  are not published. Literal protocol-looking text, code and multilingual text
  are preserved. Empty replies fail unless a persisted deliverable exists.
- Bounded SSE reconnect/read-only completion reconciliation, whole-request
  deadlines and HTTP cancellation do not resend uncertain prompts or replay actions.
- Account/channel/mutation fences prevent stale history, Shared files and viewer
  responses from restoring revoked state. Final messages cannot regress. Drafts
  have a separate store; older history is virtualized, with bounded inactive
  caching and warm-lease cancellation cleanup. Current execution and queued work
  are selected separately.
- Authoritative `computer.activity` shows a Shared Bot Computer card inside the
  current chat. One viewer persists across expansion; the sidebar reveals it.
  Handoff, hidden surfaces and revocation tear down automatic viewing. Frames
  remain ephemeral; saved logins/files remain shared and are disclosed.
- Viewer teardown aborts pending input and relinquishes its exact control lease,
  including after account revocation. The computer backend releases held keys
  and buttons before resuming the agent; old input batches are fenced. Failed
  cleanup retains the execution fence and owners can retry after lease expiry.
- A cold first answer renders its exact verified text immediately while the
  Markdown chunk loads; no blank answer or unverified fallback is substituted.
- Native Telegram connection/settings, manager configuration, member pairing,
  encrypted durable inbox/outbox, stable admission, explicit uncertain delivery,
  media, future routine subscriptions and text-first voice replies reuse the
  existing Bot runtime. Groups and arbitrary executable plugins remain excluded.
- Bounded Telegram control, admission, reconciliation, delivery and speech jobs
  keep slow downloads or providers from blocking other members. Durable
  cancellation markers survive admission races and lost cancellation replies;
  unknown admission is reconciled without submitting the prompt again. Purge
  serializes with in-flight token configuration and aborts jobs started during
  that wait.
- Telegram polling rotates by actual scheduled work, including hosts with more
  than 100 connections. Separate command capacity keeps a full ordinary inbox
  from blocking cancellation. Quota refusals are durable, never admitted, and
  receive a resend notice; retained transport rows/bytes are bounded.
- Separately encrypted host-owned speech settings, explicit endpoints/credentials,
  readiness probes, audio validation, concurrency/size/time limits and independent
  speech failures. Telegram media is capped at 10 MiB; the speech service ceiling
  is 20 MiB, five minutes and 4,000 automatic spoken-reply characters.

## Automated evidence

| Check | Observed result |
|---|---|
| Full UI suite, after final lazy boundaries | **4,027 passed, zero failures, 12,907 assertions across 557 files** using the normal isolation-aware runner |
| Full web package suite after final queue/poll stress fixes | **3,120/3,120 passed across 320 files** with one worker and a 120-second test bound (96.23 seconds total) |
| Host multi-user and existing TTS integrations | 439/439 passed across 53 files with one worker |
| Repository script tests | 211/211 passed; an initial inventory failure from the temporary HEAD comparison archive passed after that owned archive was removed |
| Bot contracts / shared runtime | 36/36 and 87/87 passed respectively |
| Harness / orchestration / Electron packages | 135/135, 271/271 and 227/227 passed respectively |
| VS Code package suite | 241 Vitest tests plus 21 Bun tests passed across 41 files |
| Supervisor / engine proxy / egress / indexer | 39/39, 5/5, 23/23 and 22/22 passed respectively |
| Cursor runtime / legacy desktop / visual matrix | 125/125, 39/39 and 2/2 passed respectively |
| Documentation validator | Passed (7 published pages and 7 sidebar links); this does not validate the optional database migration |
| Web Bot suite, 65 files | 592/595 passed in one run; three unchanged purge tests timed out under host contention |
| Isolated purge retry | 15/15 passed with a 120-second bound, including the three timed-out cases |
| Reply/provider/voice focused suite | 137/137 passed before subsequent manager-metadata regression additions |
| Recovery bundle retry | 6/6 passed; initial five-second runs timed out under contention |
| Root UI/API/viewer regression set | 66/66 passed |
| UI state/warm-up/current-run focused set | 70/70 passed; subsequent finality and Shared scope regressions also passed |
| Mounted settings and transcript | 12/12 passed before the later manager-specific case |
| Shared Bot runtime + visual matrix | 38/38 passed |
| Computer activity/browser/routes/runtime integration | 62/62 passed |
| Telegram backend | 42/42 passed after manager-without-membership correction |
| Final Telegram authorization/owner audit | 48/48 passed; four new cases reproduced races before the fix, including authorization changes during durable transitions and stale delivery owners |
| Telegram admission-expiry follow-up | 51/51 passed before the subsequent transport-lane work; requests crossing fifteen minutes during transcription/database waits cannot execute |
| Final Telegram regression suite | 89/89 passed, including hung speech/media, generation/owner loss, uncertain admission, cancellation races, command capacity, quota notices after restart and 101-Bot polling fairness |
| Independent final polling / purge probes | All 101 enabled Bots polled over 161 virtual ticks with at most 16 polls active; a job started while purge waited for configuration was aborted, with zero surviving credentials/connections/admissions |
| Computer backend held-input cleanup | 59/59, 201 assertions; actual Chromium/image verification remains pending |
| Viewer input cancellation and cleanup | 42 tests/723 assertions; later expired-lease and duplicate-return regressions: 22 tests/134 assertions |
| Host viewer/control/account integration | 57/57 across browser service, activity and routes |
| Cold first-answer rendering | 36 focused tests plus an isolated cold-render regression; preserves exact text and excludes acknowledgment/partial content |
| Inactive inline computer / transcript feedback | 3/3 mounted tests (19 assertions), including initial loading, empty state, draft isolation and final-only rendering |
| Final Telegram/speech/settings/event deltas | Telegram 42/42, speech 26/26, combined mounted UI 18/18 (91 assertions); two initial five-second UI timeouts passed quickly at the bounded retry |
| Normalized event-to-DOM | Actual `createBotEventReconciler().ingest` path plus mounted EventSource/account cleanup: 3/3, including finality, replay, channel ACL and revocation |
| Lint | Final full workspace command passed without errors or warnings; focused backend lint also passed |
| Application type checking | Web, standalone UI, VS Code host/webview, Electron syntax checks all passed sequentially; the legacy desktop script is a no-op and also exits zero |
| Whitespace/diff check | Passed |

Logs are under `.tmp/bot-upgrade-*.log`, `.tmp/bot-root-ui-retest.log`,
`.tmp/reply-voice-final.log` and `.tmp/recovery-recheck.log`. Counts overlap;
they must not be summed into a single claimed test total.
The final independent stress probes are retained in
`.tmp/bot-telegram-review-final-probes-recheck.log`.

## Recovery soak

The long-lived synthetic process ran for **3,600,080 ms** and passed:

- 28,768 cycles and 230,144 concurrent injected reads;
- 423,298 assertions and 4,110 account-reset interleavings;
- 14,384 rejected old warm-ups and 14,384 released leases.

It covers in-process transcript/Shared read/event/cache/prewarm races, not live
providers, Telegram, browser layout or durable-host recovery. Development
continued during the hour; a separate 30,107 ms final-store-source replay passed
248 cycles and 3,644 assertions. Evidence:
`.tmp/bot-upgrade-soak-summary.json`, `.tmp/bot-upgrade-soak.jsonl`, and
`scripts/bot-upgrade-soak.ts`.

## Browser observations and performance limits

Real production components were exercised through the in-app browser using the
disposable Vite fixture at `tests/visual-production-bots/`. Telegram requests in
that fixture stay in memory and never reach Telegram.

- Isolated draft updates caused zero transcript commits in mounted tests and
  the initial browser runs. Broader Electron profiler observations are qualified
  below because they also count asynchronous descendant work.
- A 1,000-message history mounted 20 rows; the 5,000-message fixture mounted
  roughly 40 rows while retaining a scroll window and the active tail.
- Automatic computer appearance, expansion/collapse, take/return control were
  exercised with a real decoded synthetic screen. Expansion/collapse did not
  create another stream; measured peak simultaneous streams was one.
- Telegram enable/save, credential-field clearing and claimed numeric pairing
  confirmation were exercised in the browser fixture. Uncertain delivery retry
  showed an explicit duplicate warning and returned to a queued state without
  bot execution. Screenshot: `.tmp/bot-telegram-dark.png`.
- Telegram setup was also inspected at 390 × 844 with the fixture drawer
  closed; the card wraps within the viewport. Screenshot:
  `.tmp/bot-telegram-narrow.png`. The browser viewport override was reset.

Thirty-sample runs measure two-animation-frame fixture delay (milliseconds),
not live provider latency or a clean before/after comparison:

| History | Draft p95 | Working p95 | Final p95 | Transcript commits while typing |
|---|---:|---:|---:|---:|
| 1,000 | 212.8 | 248.2 | 97.3 | 0 |
| 5,000 | 51 | 148 | 79 | 0 |

An earlier short 1,000-row run measured draft p95 42.2 ms, one working sample
135.5 ms and one final sample 72 ms. It is not equivalent to the repeated p95
run. Severe host contention was observed (load averages above 40, multi-minute
disk stalls and browser-control timeouts). Those in-app browser runs did not
meet the typing/working targets. Later Electron results are separate evidence,
not a replacement for these observations. Warm/cold provider benchmarks,
complete keyboard/IME and cross-layout acceptance remain open.
The 5,000-row screenshot is `.tmp/bot-upgrade-5000.png`.

An isolated Electron visual shell subsequently passed sixteen interactive checks
with no renderer errors: 1,000-message virtualization, draft/working/finality,
automatic computer appearance and expansion, takeover/return/Hide cleanup,
Telegram configuration/pairing, uncertain retry, partial speech readiness, and
narrow dark layout without horizontal overflow. The computer had one stream
before and after expansion, and zero after Hide. These use synthetic transport
and screen fixtures, not the managed Docker computer or a packaged release.
Evidence: `.tmp/bot-upgrade-electron-visuals/evidence.json` and screenshots in
that directory.

That shell's first 30-sample run starting with 100 messages measured draft p95
27.6 ms, working p95 57.7 ms, and final p95 28 ms. One transcript commit occurred
during typing, unlike the zero-commit mounted and earlier browser runs; initial
layout settling was not excluded in this run. The timing targets passed only
for that fixture run, not the complete acceptance matrix. Benchmark working
cycles append new turns, so history counts denote starting lengths.

The final Electron run collected three repetitions at each starting history length
(100/1,000/5,000), with thirty samples per interaction in every repetition.
Warm-up required rendered assistant Markdown and three stable paint samples.
All nine runs met the proposed local timing targets:

| Starting history | Draft p95 range | Working p95 range | Final p95 range |
|---|---:|---:|---:|
| 100 | 27.9–28.6 ms | 27.0–27.8 ms | 26.7–28.1 ms |
| 1,000 | 28.4–28.8 ms | 26.9–28.6 ms | 26.8–28.1 ms |
| 5,000 | 26.9–28.3 ms | 27.2–28.8 ms | 26.7–28.4 ms |

The profiler recorded no transcript commits
during typing at 100 messages and one per run at larger histories. The remaining
commit is consistent with the virtualizer's delayed scrolling-state reset; this
is an inference, not proof that every descendant commit was caused by layout.
These are warm, synthetic Electron fixtures, not provider-time measurements or
a production release acceptance result.

Three separate fresh empty-history Electron trials reproduced cold first-answer
text waiting 646.8/436.4/467.5 ms for the lazy Markdown implementation. With the
verified plain-text fallback, it appeared after 45.6/40.0/34.6 ms. This is roughly
a 91.4% median reduction in that reproduced UI delay (467.5 to 40.0 ms), based on three trials—not a p95 or
an overall application/provider speedup. Evidence:
`.tmp/bot-upgrade-cold-before/evidence.json` and
`.tmp/bot-upgrade-cold-after/evidence.json`. Live task-success scores remain
unverified, so the combined overhead/task-success acceptance gate is still open.

## Deployment and outstanding acceptance

The native adapter follows the separation of platform events and outbound
delivery illustrated by [AstrBot's adapter documentation](https://docs.astrbot.app/en/dev/plugin-platform-adapter.html)
and the long-polling approach described by [NoneBot's Telegram adapter](https://github.com/nonebot/adapter-telegram/blob/beta/MANUAL.md).
Neither runtime was imported. Telegram's acknowledgement/retention contract was
rechecked against the [Bot API](https://core.telegram.org/bots/api#getupdates),
and delivery pacing against its [rate-limit guidance](https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this).

- `supabase/migrations/20260831002620_bot_telegram_transport.sql` is additive
  and does not advance the global Bot schema marker. Missing optional schema
  leaves ordinary Bot chat available. SQL and pgTAP were reviewed but not run:
  Docker's socket was unavailable, and installed PostgreSQL client tools lacked
  the server binary. The Docker prerequisite was checked again after the final
  code changes and remained unavailable. No database state was changed.
  Quota/payload-growth and replay SQL contracts have offline checks and pgTAP
  coverage prepared, but those checks do not substitute for executing PostgreSQL.
  Payload-growth checks use a non-waiting connection lock to avoid reversing
  ingest/prune lock ordering; contention fails the write explicitly before
  admission, rather than automatically repeating transcription or submission.
- Telegram/speech remain disabled until explicitly configured. The host must
  remain running. Unadmitted requests expire after fifteen minutes; Telegram's
  own update retention is at most twenty-four hours.
- Live Telegram/media/voice/provider tests and reserved-account acceptance are
  unverified. No credentials were fabricated or inherited.
- Initial parallel type checks stalled, and another sequential attempt was
  stopped after fifteen minutes. Sequential Bun `--smol` checks then completed:
  the compiler exposed test-fixture typing defects, which were corrected, and
  all application package configurations passed. No production type errors
  remained. Logs: `.tmp/bot-upgrade-*-typecheck-final.log`.
- Electron main bundling passed. Full `electron:build` failed before packaging
  because the required signed `images.release.json` manifest is absent. That
  release safety gate was not bypassed.
  Main bundling, Electron syntax checks and full workspace lint were repeated
  successfully after the final Telegram JavaScript changes.
- The VS Code extension-only build passed (1.7 MB); it emitted three existing
  `import.meta`-in-CommonJS warnings from unchanged Cursor runtime files. This
  was validated separately from the successful VS Code webview build.
- The web Vite build was stopped after 20 minutes 32 seconds without progress
  beyond `transforming...`, during severe disk stalls. It emitted no compiler
  diagnostic and is not marked passed. Log: `.tmp/bot-upgrade-web-build.log`.
- A subsequent `bun --bun run build:web` passed, including service-worker output.
  It retained existing ONNX `eval` and large-chunk warnings. Subsequent web and
  VS Code webview emitted builds also passed with the cold-render fallback and
  final usage-gated sidebar boundaries. Electron main bundling also passed;
  packaged-release prerequisites remain distinct from emitted source builds.
- Startup budget limits were not changed. Before the final boundary work, web
  exceeded its gzip limit by 7,086 bytes and VS Code by 60,478 bytes. Rebuilding
  committed HEAD with the same dependencies also exceeded the VS Code limit by
  36,263 bytes. That baseline excludes all preexisting uncommitted work, so the
  dirty-tree delta cannot be attributed solely to this upgrade. The final real
  sidebar splits saved 25,569 raw / 8,197 gzip bytes in web startup. Web now
  passes its gzip limit (1,455,277 bytes), but remains **835 raw bytes over** its
  4,962,877-byte raw limit. VS Code remains over both limits at 4,037,588 raw /
  1,162,611 gzip bytes. These are failures, not waived checks; no new first-use
  delay or risky recovery refactor was introduced merely to reduce the count.
  Both deferred Bot panel assertions and all thirteen bundle-checker tests pass.
  Full evidence is `.tmp/bot-upgrade-build-summary.md`.

Transport/speech secrets intentionally do not enter recovery bundles; a
restored host must configure credentials and pair again. Production migration
and release remain separate reviewable operations.

The held-input release changes also require rebuilding the Bot computer image;
unit/HTTP fixtures do not verify the installed Docker image's behavior.
