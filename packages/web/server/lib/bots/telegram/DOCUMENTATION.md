# Native Telegram transport

`service.js` is a transport adapter over canonical Bot channels and dispatcher
admission. It never calls reasoning models or changes model selection. The
runtime composes it only on a managed Supabase host; its `start`/`stop` follow
the existing background-owner lifecycle. `isOwner` is rechecked after async
preparation, and a database lease additionally prevents two hosts from polling
one connection at the same time.

`client.js` uses native fetch against the fixed Telegram Bot API origin. It
rejects redirects, bounds JSON and streaming media (10 MiB), validates numeric
private identities, splits text without interpreting Markdown/HTML, and never
includes remote response bodies or token-bearing URLs in errors. Telegram
429s schedule delayed retry; transport failures during a send are uncertain.
Polling uses 20-second long requests and bounded exponential failure backoff.

## Settings and pairing

Managers configure a BotFather token independently of the Bot profile. Each
Telegram identity belongs to one DevRyan Bot. Token validation checks `getMe`
and refuses an existing webhook without removing it. Long-poll conflicts stop
polling until a manager resolves the competing consumer and saves again.
Telegram is disabled by default. Saving configuration changes its generation;
existing pairings and pending delivery are invalidated, requiring members to
pair again. This makes token replacement and disable/re-enable fail closed.
Global administrators without Bot membership can configure the connection and
read connection metadata. Their status has `canPair: false`, no pairing and no
delivery rows; personal pairing and delivery operations still require active
membership, as does every background request and delivery.

Members create a ten-minute, single-use link. Only its SHA-256 digest is stored.
The first private Telegram `/start` consumes the nonce and records a candidate
numeric account ID; no Bot access is granted until that same DevRyan member
confirms the candidate inside authenticated DevRyan. Confirmation atomically
replaces that member's former pairing. Group chats, usernames as identities,
other bots, and unmatched users cannot admit requests. The canonical owner
channel is reused, including the existing shared Bot memory and shared computer
semantics. Setup must disclose Telegram/external speech processing and host
availability; the runtime must stay running and Telegram expires its queued
updates after 24 hours.

## Persistence and recovery

`store.js` owns four explicit-select service-only repositories and narrow RPCs.
All tables force RLS and revoke browser-role privileges. The separate additive
`bot_telegram_transport` migration does not advance the global Bot schema gate;
missing tables produce `migration_required` in Telegram status without
disabling existing Bots. Tokens live under
`<dataDirectory>/bot-integrations/telegram/bots/vault/credentials.v1.json`, using
the existing encrypted, atomic host vault. This vault is never registered as a
model credential source or environment-secret source.

Inbox insertion and update-offset advancement are one fenced transaction. Each
update has deterministic inbox, message, and admission identities. Admission
response loss and surviving `admitting` intent are reconciliation-only. Even
when the canonical message is not visible yet, the prompt is never resubmitted.
The uncertain incoming state is visible in settings. Unadmitted requests older
than 15 minutes expire with a resend notice. Profile, effective Bot policy,
membership, channel access and generation are checked again during processing.
The original update deadline is rechecked immediately before admission, after
media/transcription and durable writes. Already admitted requests still reconcile
their canonical message even when delivery recovery crosses that deadline.

Only persisted finalized result messages enter the encrypted outbox; no
intermediate prose or screen frames do. An incoming request owns its result
delivery. Unrelated desktop messages are never mirrored. Routine results need
the member's explicit opt-in; the service-only `routine_results` query recovers
undelivered canonical completions from the last seven days after restart,
bounded to 25 per pass and excluding runs predating subscription.

Outbox parts carry durable progress. `sending` is committed before each
external write; a process crash or unknown send response becomes `uncertain`
and is not retried automatically. An explicit delivery retry resumes the last
unsuccessful part and may duplicate that part; it never reruns a Bot. Partial
results remain visible. Media is downloaded through ordinary Bot blob ACLs and
uploaded as bytes. Delivery is limited to one item per destination per pass,
with at least 1.1 seconds between multipart sends.
Admission and delivery revalidate binding and the database owner lease after
their durable state transition. Sends compare the expected part index so a
former owner cannot overwrite another owner's progress after a slow read.

`jobs.js` isolates bounded control, admission, reconciliation, delivery and
optional synthesis lanes. Scheduling scans select metadata only (including
indexed `request_kind`); encrypted payloads are fetched after claiming a slot.
Across the host, ingress is capped at eight jobs, with at most three media
downloads and two transcriptions; one Bot gets at most four ingress jobs,
three text jobs, one media job and one transcription. Control has two global
slots and one per Bot, delivery four global/two per Bot, reconciliation four
global/one per Bot, and synthesis two global/one per Bot. Active row IDs and
durable state comparisons prevent duplicate in-flight processing. Bot scans
use rotating keyset pages of 100 connections; destination head scans exclude
already active/selected pairings so one backlog cannot hide another member.
Long polling has its own available-slot cursor and a 16-request host cap. It
does not advance while all slots are occupied, preventing page rotation from
starving later connections. A deterministic 101-Bot fixture holds polls for
20 virtual ticks and verifies every identity is polled with no more than 16
requests alive.

Ingress quotas are atomic under the connection row lock: ordinary active work
is limited to 1,000 rows / 96 MiB and authenticated commands have a separate
100-row / 4 MiB reserve. Overflow becomes `quota_rejected`, never executable;
it retains encrypted update identity only and schedules a visible resend/retry
notice through the control lane. Such refusals are included in member metadata
and survive restart before notice delivery. They cannot become `/cancel` targets.
The command reserve is also bounded, so excessive commands are explicitly
refused rather than bypassing quotas or authorization. Total inbox retention
is capped at 5,000 rows / 128 MiB; oldest terminal outcomes (including undelivered
quota notices) expire first under pressure, while active work is preserved.
Previously acknowledged update IDs are never revived after retention cleanup.
Envelope growth during preparation is checked against the same byte budgets.
Its trigger acquires the connection lock with `NOWAIT` to avoid a lock-order
deadlock with ingest or purge. Contention fails the write before admission and
surfaces the existing explicit request-failure/resend guidance; transcription
is never automatically repeated to recover that failure.

`/cancel` selects only the sender's preceding requests and durably records
`cancel_requested_at` before aborting media, transcription or admission waits.
A request advancing during that write is cancelled using the returned state.
Unknown admissions are inspected until the exact canonical run can be cancelled,
without submitting a prompt again. Lost cancellation responses retain the
marker and retry cancellation of that same run until terminal. Optional audio
is cancelled separately; an audio send already in flight remains visibly
uncertain. Stop, owner loss, rotation, disconnect, relinking and purge abort
the matching row controllers. Native HTTP waits and body readers are abortable
even if a transport ignores its signal; existing database requests retain their
15-second transport timeout. Purge serializes with configuration and removes
credentials written by a configuration that was already in progress.

Payloads use deployment-key AES-GCM with row- and purpose-bound associated
data. Inbox plaintext is bounded at the Telegram JSON boundary; no file bytes
are stored there. Old generations become non-executable/non-deliverable during
pruning. Settled/rejected inbox and delivered/cancelled outbox retain up to seven days;
failed/uncertain outbox and revoked pairings retain 30 days. Full Bot purge
deletes all transport rows and the separate vault, and handles the absent
optional migration without blocking ordinary Bot deletion. Recovery bundles
do not export this new transport vault; restored hosts require token setup and
fresh member pairing instead of silently restoring external destinations.

## Voice boundary

The injected Bot speech service receives stable transcription/synthesis
operation IDs and independently configured credentials. Incoming voice is
limited to five minutes, committed as `transcribing` before invoking speech,
and its actual transcript is encrypted before normal Bot admission. A crash
mid-transcription never generates an invented or duplicate prompt. Missing or
empty transcription fails visibly. Final verified text is delivered before
speech synthesis, with no extra reasoning turn. The same answer is spoken only
for voice-origin requests with voice replies enabled; replies over 4,000
characters remain complete in text and get an audio-limit notice. Speech
uncertainty is visible and never causes successful text to be resent.
After text completion, the same outbox record moves through `synthesis_pending`
and `synthesizing`, releasing its delivery slot. The generated audio appends to
that record at the existing part index; new text and cancellation can proceed
while synthesis waits. No extra model turn or repeated successful text is used.

Tests: `bun run --cwd packages/web test server/lib/bots/telegram
server/lib/bots/telegram-routes.test.js`; database behavior and
service-only security are covered by
`supabase/tests/bot_telegram_transport.test.sql`.
