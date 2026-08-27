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

## Private chat

`chat/BotChatView.tsx` composes canonical paged messages, the latest accepted
run state, and the retained composer draft. Messages use the existing
`MarkdownRenderer` with file-reference interactions disabled. They are rendered
by Bot-owned rows and never fabricated as OpenCode session/message/part records.
The conversation header has an 88px desktop minimum rather than a fixed height.
It shows a 64px circular avatar plus a vertically centered Bot name/title block
that can grow for bounded wrapping. Mobile uses a 56px avatar and the same
content-driven rule. Left navigation and Bot Operations controls are rendered
by shell-owned edge chrome outside the identity flow, so macOS titlebar sizing
and control width cannot collapse the profile presentation. Assistant message
groups use a 56px circular avatar so Bot identity remains prominent in the
transcript.
Assistant messages are left-aligned conversational groups with the avatar on
the first message; user messages are higher-contrast bubbles aligned right.
Timeline spines, revision/checkpoint seams, repeated actor labels, system rows,
and tool-call records are intentionally absent. Tool turns render the
Bot-authored acknowledgment and completed result as distinct assistant bubbles;
intermediate tool narration is not part of the transcript. Timestamps remain
subtle and keyboard accessible. The chat has no separate run-status strip:
while the latest run is starting or running, a 56px Bot avatar and animated
typing dots appear before visible assistant content and reappear after a
finalized acknowledgment until the separate result arrives.
Run state, cancellation, and approval/reconciliation requirements remain in the
Operations rail. A failed or interrupted run also renders a compact inline
notice after that run's last visible message, including when its assistant
checkpoint is empty or partial. Only safely classified retryable failures offer
Retry. Retry is explicit, locks its notice while pending, and asks the server to
requeue the same pre-execution run without creating another message. There is no
automatic retry. An expired approval remains visible as the run's terminal
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

The composer sends one client-stable message ID. One atomic store update inserts
the optimistic row, clears the exact draft, updates order, and marks acceptance
pending before the request begins. Only that short acceptance window disables
the composer; queued and running work does not. A definitive rejection removes
the row and restores the exact text/attachments. An ambiguous transport result
keeps a visible **Not confirmed** row, refreshes canonical history, and retries
once with the same message/idempotency identity. `Reader` channels are disabled;
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

`message.streaming` renders requester-only Markdown before the next canonical
checkpoint. The transcript subscribes only to the live message ID, while its
memoized row subscribes to that message's text/revision in the narrow
`useBotLiveMessageStore`. Canonical revisions cannot regress newer live text;
final messages, terminal runs, removals, principal resets, and reconnect
snapshots clear it. Historical acknowledgment-phase messages remain stored but
are hidden from the transcript and channel previews. Typing starts with local
send acceptance and remains visible for queued, starting, and running runs.

Activating an idle send-capable channel requests a two-minute, principal-bound
runtime lease. The client passes its opaque lease ID on an eligible attachment-
free send, releases unused leases on channel changes/unmount, and requests a new
lease after the selected channel settles. Warming is best effort; cold sends use
the same correctness and authorization path.

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

`BotBrowserDiagnostic.tsx` automatically starts viewing when an Active Bot's
Computer tab is visible. It stores only the server-issued ephemeral viewer
descriptor and mounts its one-use authenticated multipart URL; Stop, tab,
Bot/channel change, unmount, stream failure, Bot deactivation, and principal
reset release it. A manual Stop suppresses automatic restart until the tab is
reopened or the user explicitly starts viewing again. Viewer identity is
Bot-scoped, so run settlement does not interrupt the persistent computer.

Pixels, frames, and canvas data never enter Zustand, browser storage, logs, or
artifact state. Any active Bot member may view and use take/return control. A valid human-control lease is
independent from viewing: it pauses agent input, identifies its controller,
heartbeats only for the owner, and expires at the server timestamp. The UI
always states that frames are never recorded.

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
  components/stores and drives 38 Electron-CDP screenshots. It blocks on
  overflow, scroll/focus, keyboard/dialog accessibility, secret sentinels,
  console errors, and unhandled rejections, and never enters the production
  bundle.

## Validation

Run the focused UI suite with:

```bash
bun test packages/ui/src/components/bots packages/ui/src/stores/useBotChannelStore.test.ts
bun run type-check:ui
```
