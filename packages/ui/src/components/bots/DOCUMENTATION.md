# Production Bot UI

The availability, Docker recovery, privacy, and incident runbook is
`docs/BOTS_RUNTIME.md`. This document owns renderer behavior and performance.

## Purpose

`packages/ui/src/components/bots` owns the private Production Bot conversation
and operations surfaces. A Bot channel is not an OpenCode session: these
components render the Bot HTTP/SSE contracts and dedicated Bot stores directly.
Settings administration is intentionally separate in
`components/sections/bots/`. Its product surface is Overview, Resources,
Memory, Members, Routines, and Lifecycle. Resources combines the Bot computer,
optional on-demand Skills/SOPs, protected provider credentials, and write-only
environment secrets. Internal working revisions remain persistence machinery
and are never presented as a user concept.

Lifecycle also lets the current channel owner clear the messages and private
attachments shown in their canonical chat. The destructive confirmation uses
the existing owner-only channel deletion contract, refuses while a run is
unfinished, preserves shared Bot learning, and creates a fresh empty owner
channel so chat remains immediately usable.

Overview combines the public profile with the revision-backed Soul/personality,
Standing Role, Objectives, and compact primary Provider/Model/Thinking controls. Profile-only edits save immediately. Core
identity edits create a working revision only when Apply Changes is confirmed,
then affect future runs after publication. Operating/Prohibited/Extra
Instructions, Maximum Output Tokens, and Short Summary remain absent.

Environment secrets remain available for an Active Bot. The renderer stores
only names, status, and timestamps; it never prefills, copies, or receives a
value.

The Resources computer view browses the Bot's persistent filesystem and can add
desktop files/folders to `/workspace/Resources`. Safe text is automatically
indexed as reference material. Server-returned `rootLabel` drives breadcrumbs:
a global administrator sees **Computer** rooted at `/`, while another settings
user sees **Workspace** rooted at `/workspace`. Restricted directories, links,
and special files remain visible but have no navigation action. Open in Finder
reveals only the original imported local path through native IPC.

## Navigation and host behavior

- `shared/ProductAudienceTabs.tsx` and `useMainSidebarAudienceStore` provide the
  session-local **Agents / Bots** sidebar tablist. Cold start is Agents;
  switching audiences does not clear the selected coding session/draft, selected
  Bot, or Coding Agent main tab.
- A managed principal whose effective `bots` capability is Off never starts the
  capability probe or Bot SSE owner. The audience store rejects Bots selection,
  all shared Agents/Bots tablists collapse away, Bot-only Settings destinations
  are removed, and any retained selection is reset to Coding Agents.
- `sidebar/BotSidebarSection.tsx` renders assigned Bots only while the sidebar
  audience is Bots. Selecting a Bot switches the main surface by audience and
  coalesces creation of the current principal's owner channel without mutating
  ordinary session state. It is a conversation roster rather than the Settings
  catalog: each 72px row presents a 44px circular avatar, Bot name, finalized
  latest-message preview, and compact relative time. Finalized previews rank the
  list by recency without moving rows during streaming. Coding Agents exclusively
  renders project/session, draft, search, multi-run, and scheduled-task controls.
- VS Code exposes one deliberate entry that renders `Bots require the DevRyan
  macOS app`. It never opens a Bot channel or calls Electron runtime-management
  IPC.
- A browser connected to an Electron-hosted server can use the full Bot HTTP/SSE
  UI. Setup and Repair remain absent there because `botsDesktopApi` requires both
  local Electron IPC and the local desktop origin. In the actual desktop renderer,
  recovery is available from both an existing Bot conversation and the Settings
  publication-readiness image gate, so the first Bot has no setup dead end.
- `BotView.tsx` is loaded through `components/views/lazyViews.tsx`; shell
  components must not statically import the view.
- The roster implementation loads only after the authorized Bots audience is
  selected. The Operations rail implementation loads only when its sidebar is
  open for a selected Bot. These boundaries defer unused presentation code;
  the shared event owner and account-revocation cleanup remain unchanged.

## Private chat

`chat/BotChatView.tsx` composes canonical paged messages, the latest accepted
run state, and the retained composer draft. Messages use the existing
`MarkdownRenderer` with file-reference interactions disabled. They are rendered
by Bot-owned rows and never fabricated as OpenCode session/message/part records.
While the Markdown chunk loads, a finalized Bot answer renders its exact text
as escaped, whitespace-preserved content. The rich renderer replaces that text
when ready; this fallback is never available to acknowledgment or unfinalized
rows, and does not pull Markdown into the startup bundle.
The conversation header has an 88px desktop minimum rather than a fixed height.
It shows a 64px circular avatar plus a vertically centered Bot name/title block
that can grow for bounded wrapping. Mobile uses a 56px avatar and the same
content-driven rule. Left navigation and Bot Operations controls are rendered
by shell-owned edge chrome outside the identity flow, so macOS titlebar sizing
and control width cannot collapse the profile presentation. Assistant message
groups render without an avatar or reserved avatar spacing; Bot identity remains
available in the conversation header. Assistant messages are left-aligned
conversational groups; user messages are higher-contrast bubbles aligned right.
Timeline spines, revision/checkpoint seams, repeated actor labels, system rows,
and tool-call records are intentionally absent. Every send starts with an empty
pending assistant row. A simple no-tool turn promotes it directly to the one
natural result. Tool turns also publish only the verified final answer.
Historical acknowledgment rows and unfinalized prose remain stored but hidden;
intermediate narration and ambiguous streaming text never enter the transcript. Timestamps
remain subtle and keyboard accessible. The chat has no separate run-status
strip: avatar-free animated typing dots may appear while the pending row is
empty and never reappear after visible response content arrives.
Run state, cancellation, and approval/reconciliation requirements remain in the
Operations rail. A failed or interrupted run also renders a compact inline
notice after that run's last visible message, including when its assistant
checkpoint is empty or partial. Only safely classified retryable failures offer
Retry. Retry is explicit, locks its notice while pending, and asks the server to
requeue the same pre-execution run without creating another message. There is no
automatic retry. A retry refusal refreshes the authoritative run and preserves
its messages, drafts, attachments, and partial responses. Allowlisted refusal
reasons hide permanently stale retry controls and explain configuration changes,
lost access, already-started execution, or temporary scope contention. A
permanent refusal wins over an older `retryable` projection. Timeouts and an
unavailable runtime have distinct notices. An expired approval remains visible as the run's terminal
reason, and later queued work states explicitly that FIFO execution can continue.
Pre-execution configuration failures are rendered as terminal notices with a
Retry action, so an accepted send never disappears without a visible outcome.

Governed action attempts do not render tool/status markers or review controls
inside assistant responses. Current run state and confirmation controls remain
in the separate Operations rail. Arguments,
credentials, sensitive targets, hidden tool output, and adapter execution IDs
never enter the transcript DOM.

`apps/botEventConnection.ts` owns the generation-guarded Bot EventSource.
Network, JSON, envelope, epoch, and snapshot failures close the current source
before a bounded 250ms/1s/2s/5s reconnect. A socket open is not treated as
healthy: only a fresh authoritative snapshot restores Connected. After a
reconnect snapshot, the active transcript merges the canonical newest page;
older loaded messages, stable message references, and the older-page cursor
remain intact.

Capability discovery is part of that same connection lifecycle. A transient
`migration_required`, `supabase_unavailable`, or capability transport failure
keeps its bounded error code visible while a single principal-scoped probe
retries at 250ms/1s/2s/5s/15s. A newly available control plane immediately
opens SSE and replaces the Bot catalog from its authoritative snapshot. Manual
Retry invokes the capability probe even when no EventSource was created, and
principal changes dispose both probe and EventSource timers.

Electron Bot runtime progress remains component-local rather than entering a
broad store. App-bound mode receives immediate IPC events. Background-service
mode additionally polls the authenticated operation snapshot only while its
phase is nonterminal, cancels polling on unmount, and refreshes authoritative
capabilities when `ready` or `failed` arrives so stale `checking` state cannot
keep recovery controls disabled.

The composer sends client-stable user-message and assistant-response IDs. One
atomic store update inserts the optimistic user and empty pending assistant
rows, clears the exact draft, updates order, and marks acceptance pending before
the request begins. The `202` response reconciles both rows to their canonical records without a
duplicate. Only that short acceptance window disables the composer; queued and
running work does not. A definitive rejection removes both rows and restores
the exact text/attachments. An ambiguous transport result keeps a visible **Not
confirmed** row, refreshes canonical history, and retries once with the same
identities. `Reader` channels are disabled;
`Owner` and `Collaborator` channels depend on authoritative `canSend`.

The private-file picker accepts multiple supported files in one selection, up
to the server-owned 32-attachment message limit and 25 MiB per-object limit.
The composer also accepts local file drops through the same private upload
pipeline; the transcript is not a drop target. File picker and drop uploads use
the same validation, sequential processing, and partial-success behavior.
Uploads remain sequential so a large selection does not retain every raw buffer
and base64 copy at once. Browser-empty and generic MIME declarations are
resolved from allowlisted extensions; legacy `image/x-png` and `.png`/`.PNG`
files normalize to `image/png`, while the server still verifies the declared
MIME against the file signature. Each successful object is appended to the
latest draft immediately. A later failure therefore keeps earlier successes,
preserves concurrent text edits, and reports the failed filename and reason so
only that file needs to be selected again.

The transcript renders canonical finalized result rows only. Legacy
`message.streaming` events may be reconciled for compatibility but never render.
Immediate animated working feedback remains until a final answer or terminal
failure. `useBotDraftStore` isolates composer edits from transcript subscribers.
History pages are guarded by account/channel generations and message mutation
versions; finalized messages cannot regress to partial data. Initial transient
502/503 failures retry with bounds and expose a direct Retry action.
Histories over 100 rows virtualize older rows with the existing TanStack virtual
library, retaining the trailing 20 rows and synchronous scroll anchoring.
Inactive transcript caching is bounded by 20 channels and 20 MiB; active,
executing and optimistic conversations are exempt until safe to evict.
Required approval,
reconciliation, cancellation, and failure notices
remain available through their existing surfaces.

Interacting with an idle send-capable channel's composer requests a two-minute,
principal-bound runtime lease. Merely switching to the Bots audience or rendering
the selected conversation does not start a reasoning container, so ordinary
Coding Agent work keeps its runtime resources. The client passes the opaque lease
ID on an eligible attachment-free send and releases unused leases on channel
changes or unmount. Later composer interaction requests the next lease after a
send consumes the prior one. Warming is best effort; cold sends use the same
correctness and authorization path.

The selected channel's Shared inventory loads with message history. The narrow
Shared store indexes files by message ID, and memoized result-image children
show stable placeholders as soon as bot image mappings arrive. PNG, JPEG, GIF,
and WebP previews use the existing authorized object download, viewport-gated
abortable fetches, verified MIME types, bounded object URLs, decode-before-swap,
and retry. Exact `/workspace/Shared/...` Markdown references map to the same
authoritative file and are deduplicated; SVG is not previewed. The encrypted
object mapping—not the computer-volume copy—is authoritative, so an automatic
image remains inline in `pending`, `copying`, `ready`, and `failed` copy states;
the Shared tab alone offers copy retry.

The transcript follows intrinsic content growth while the reader remains within
96px of the bottom. One `ResizeObserver` watches the inner transcript rather
than the viewport, so streamed Markdown, attachments, and typing transitions
remain visible without treating composer or window resizing as new content.
Scrolling upward releases following; returning to the bottom re-pins it. Channel
changes start pinned, native scroll anchoring is disabled, and loading older
messages restores the prior visible position synchronously in a layout effect.

## Operations rail

`operations/BotOperationsRail.tsx` keeps the current run summary above three
Base UI tabs:

- Computer: automatic, ephemeral screen viewing plus human take/return control
- Confirmations: bounded action identity, risk, requester approval/rejection,
  and unknown-write reconciliation. Pending confirmations are Bot-wide without
  exposing the originating private transcript.
- Shared: conversation-associated persistent files with sender, time, fixed
  `/workspace/Shared/...` path, copy status, download, retry, and Open in
  Computer actions

The rail is selected from the active Agents/Bots audience, never merely from a
retained Bot selection: Agents always shows the existing repository/files
surfaces and Bots shows Current Run, Computer, Confirmations, and Shared. `MainLayout` also suppresses
project actions, Context, ordinary Browser, Terminal, and Multi Run surfaces.
Mobile reuses the existing right drawer rather than introducing a Bot-specific
overlay. Its connection header localizes every state, exposes only a bounded
sanitized error code, and provides a manual Retry action while disconnected.
On desktop, both Bot side rails use the compact `--oc-bot-chrome-height` inset
(`max(48px, window-controls-overlay height)`) rather than the taller conversation
identity header, keeping navigation close to the native controls without
overlap. Mobile drawers do not apply this desktop inset.
Rail labels use container width rather than viewport breakpoints so 220/280/500
px rails and the drawer share deterministic behavior. Confirmation deep-link
focus effects run only while that panel is active.

## Diagnostic screen safety

`BotInlineComputer.tsx` shows **Shared Bot Computer** only for authoritative
`computer.activity` in the current channel, or an explicit sidebar reveal.
It keeps one `BotBrowserDiagnostic` and canvas mounted across native-dialog
expansion/collapse; the sidebar reveals this viewer rather than connecting its
own. Automatic viewers are bound to the activity run; ownership handoff,
terminal settlement, account/channel changes, revocation and hidden surfaces
release them and any owned input lease. Manual viewing still exposes the same
shared saved logins/files. It stores only the server-issued ephemeral viewer
descriptor and mounts its one-use authenticated multipart URL through a
same-origin abortable fetch; Stop, tab,
Bot/channel change, unmount, stream failure, Bot deactivation, and principal
reset release it. A manual Stop suppresses automatic restart until the tab is
reopened or the user explicitly starts viewing again. A bounded streaming
parser accepts only valid multipart JPEG frames with mandatory lengths and a 2
MiB frame cap. `createImageBitmap` decodes only complete frames and a canvas
draws the newest one; connection is established after that first draw, not a
network chunk. A five-second deadline releases the descriptor and exposes a
retryable screen-unavailable state instead of leaving a black panel. Failed
connections retry at most twice before requiring explicit Retry. Manual viewer
identity is Bot-scoped, so run settlement does not interrupt the persistent
computer.

Pixels, frames, and canvas data never enter Zustand, browser storage, logs, or
artifact state. Any active Bot member may view; an Operator may take/return
control. A valid human-control lease is independent from viewing: it pauses
agent input, identifies its controller, heartbeats only for the owner, and
expires at the server timestamp. The attached canvas then sends pointer hover,
all mouse buttons/click counts, drag, bounded wheel input, ordered key events,
text/IME/paste, navigation keys, and modifier shortcuts. Coordinates map through
the actual contain rectangle and ignore letterboxing. Input is pinned to the
current `viewId` and disabled synchronously on disconnect, return, expiry,
conflict, role/channel change, or unmount. `Ctrl+Alt+Escape` leaves remote
keyboard focus. The canvas keeps at most one input request in flight, coalesces
ordinary hover/wheel updates, preserves real held-pointer movement, never drops
pointer down/up under backlog pressure, and gives queued input at most 250 ms to
drain before explicit Return Control. Hidden surfaces, stopped views, ownership
changes, and unmount abort the active input HTTP request and discard the old
queue immediately. Viewer teardown removes the local stream/ticket independently
of the control-return response; late input and control replies cannot resume an
old queue or clear a newer lease. The server control boundary must release held
input when relinquishing a lease. No movement is synthesized. Mounted regression
tests exercise stalled input and control responses through Stop, Hide, and
Return Control, including delayed responses after a replacement lease. If an
owned expired lease remains in authoritative status, its owner retains a Return
Control recovery action and a visible release-pending warning. Remote input and
heartbeats stay disabled; scoped, non-overlapping status polling stops once the
server clears the lease. Late recovery polls cannot overwrite newer control.
If stream teardown already returned control, a failed duplicate return refreshes
the exact lease before showing a warning. That confirmation is bounded to two
seconds, and a later authoritative release clears the lease-scoped warning.
While an
owned Take Control lease is visible, the component polls the
narrow status route every two seconds and changes the Bot store only for a new
diagnostic revision or browser prerequisite/health change. Sanitized warnings
distinguish blocked JavaScript/cookies, failed or allowlist-denied dependency
hosts, browser/display failure, and site rejection with its last three unique
masked paths plus repetition count. A site-rejection warning becomes an
informational status while the viewer owns control. The overlay renders managed
policy/JavaScript/cookie prerequisites as facts, reports handled dialogs, and
states when screen/input are following an open popup. Popup target changes
invalidate stale refs without replacing the viewer.
The no-recording guarantee is architectural, not copy: `framesRecorded: false`
in status, and pixels never enter stores or persistence (above).

A durable `waiting_control` run is visible in chat and Operations. The lease
owner gets an immediate Return Control action; other viewers see only “another
operator” and never an actor identifier. Generated-image previews remain backed
by the encrypted object mapping while Shared copying is pending, copying,
ready, or failed. They expose explicit loading, decoded, and retryable-error
states and validate MIME, magic bytes, and image decode before display.

## Performance and accessibility

- Shared-store subscriptions select stable IDs, records, numbers, or explicit
  shallow projections. Empty collection fallbacks are module constants.
- Bot catalog reconciliation compares name, title, summary, and avatar fields so
  published profile changes reach chat navigation without replacing unrelated rows.
- Channel previews live in the channel store and update only for finalized
  user/assistant messages; roster shells do not subscribe to streaming message
  collections.
- Shared files live in their own principal-scoped store. Initial channel loads
  replace only that channel, `shared_file.updated` changes one row, and Bot SSE
  snapshot/revocation events prune files outside the current channel ACL.
- `BotAvatar.tsx` owns image-failure fallback consistently across navigation,
  chat, and Bot settings.
- Attachment IDs are a stable channel-store projection, recalculated only when
  attachment membership changes—not for streamed text updates.
- Bot rows are native buttons with visible focus, `aria-current`, and a
  theme-aware selected outline/background; transcript,
  form, tabs, action lists, error states, and controls have explicit labels or
  live-region semantics.
- Bot transcript auto-follow observes only intrinsic content growth, uses
  narrow trailing-message leaf selectors as its no-`ResizeObserver` fallback, and
  preserves prepended-history anchors before paint.
- Audience switches use a labelled `tablist`, roving focus, arrow/Home/End
  navigation, and mutually exclusive labelled tab panels.
- Layout tests cover 220, 280, and 500px rails, light/dark theme containers, the
  existing mobile drawer, ACL presentation, exact Confirmation focus,
  queue/reconciliation state, Docker copy, and repository-control suppression.
- The committed test-only `tests/visual-production-bots/` fixture renders real
  components/stores and drives 48 Electron-CDP screenshots, including
  acknowledgment-running/result and connecting/live/disconnected/owned/
  view-only/conflicting-control scenes. It blocks on
  overflow, scroll/focus, keyboard/dialog accessibility, secret sentinels,
  console errors, and unhandled rejections, and never enters the production
  bundle.

## Validation

Run the focused UI suite with:

```bash
bun test packages/ui/src/components/bots packages/ui/src/stores/useBotChannelStore.test.ts
bun run type-check:ui
```
