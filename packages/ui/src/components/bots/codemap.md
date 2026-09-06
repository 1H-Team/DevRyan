# packages/ui/src/components/bots/

## Responsibility

Private Production Bot navigation, continuous canonical chat, and the Bot
Operations rail shared by the web and Electron renderers. Bot configuration lives separately in
`components/sections/bots/` and calls the management contracts in
`lib/botsApi.ts`.

## Design

- `BotAvatar.tsx` is the shared profile-identity primitive for navigation,
  canonical chat, and Bot settings. It renders the authenticated avatar
  URL, then the configured fallback, then generated initials.
- `sidebar/` owns recency-ranked assigned-Bot conversation rows driven by
  finalized channel previews. `botSidebarStatus.ts` projects each row's current
  run (from `useBotOperationsStore`, so a Bot working in another channel still
  shows it) to `typing` dots or a "needs you" line for approval, control, or
  reconciliation waits. The audience boundary is shared with
  `components/shared/ProductAudienceTabs.tsx` and the narrow session-only
  `stores/useMainSidebarAudienceStore.ts`.
- `chat/` owns conventional left/right grouped message presentation, the
  retained composer, and the avatar-free typing indicator shown while the
  assistant response is still empty (`BotTypingDots.tsx` is the one animated
  glyph shared with the sidebar). The composer atomically paints the
  optimistic user row plus an empty pending assistant row, reconciles both
  canonical IDs after acceptance, and rolls both back on a definitive rejection.
  A tool turn first finalizes the Bot's short acknowledgment line as its own
  bubble, then a fresh pending row becomes the verified final result; a no-tool
  turn promotes the pending row directly. Ambiguous streaming text stays hidden
  without rewriting history. `chat/BotQuestionBlock.tsx` renders a quick-reply
  question carried in a finalized result's body: tapping an option sends an
  ordinary reply through `sendQuickReply` (the typed draft survives), the
  member's next message marks it answered, and options lock while a run is
  active. Older messages are virtualized above 100 rows; the trailing
  20 remain mounted. Initial history failure has a direct Retry action.
  `chat/botAttachmentUpload.ts` owns the
  supported private-file catalog, browser MIME normalization, limits,
  HEIC→JPEG conversion and >4 MP downscaling before upload, native FileReader
  encoding, a two-wide upload pool that still reports in selection order, and
  partial-success handling for multi-file selections; every Bot request has a
  deadline (`bot_request_timeout`, treated as an ambiguous send).
  `chat/BotInlineComputer.tsx` owns the single inline/expanded shared computer
  viewer, driven by channel-authorized activity and narrow `useBotComputerActivityStore`;
  it is sized by the desktop's 16:9 aspect (never a fixed height), may grow past
  the 760px message column via the transcript's inline-size container, and
  expands to the viewport at the same aspect.
  `chat/BotResultAttachments.tsx`
  maps message-indexed Shared images and safe Markdown image references into
  viewport-gated placeholders; `chat/botImagePreviewCache.ts` owns abort,
  deduplication, MIME verification, byte/count bounds, and URL revocation.
  `chat/BotRunFailureNotice.tsx` anchors safe retryable
  failure notices to the final visible row and requeues the same authoritative
  run. `chat/botScrollFollow.ts` owns the pure
  bottom-threshold and prepend-anchor calculations used by the transcript's
  content-growth observer. It hides revision/checkpoint/tool
  transport records and does not use ordinary session
  or message components except the shared lazy Markdown renderer.
  Composer focus, pointer, typing, and file-drop intent may request a best-effort
  warm runtime lease; rendering or selecting the conversation alone never
  starts a reasoning container.
- `chat/BotMessageRow.tsx` keeps governed action metadata and controls out of
  assistant responses. Current run and confirmation state remains available in
  the separate Operations rail without adding tool-status rows to the transcript.
- `operations/` owns the current run summary, confirmations/reconciliation,
  conversation Shared files, and the ephemeral live-computer diagnostic.
  `BotComputerCanvas.tsx` owns bounded MJPEG fetch/decode/draw and the
  one-in-flight human-input pump plus bounded pointer-release draining;
  teardown aborts the input HTTP request, discards queued input, and releases
  the stream immediately while server control return proceeds independently.
  Retained expired leases keep an owner-only Return Control recovery action,
  scoped status polling, and disabled input without renewing the old lease.
  `BotBrowserDiagnostic.tsx` is screen-first: the canvas fills the widget,
  start/stop viewing, control waits, and browser warnings are overlays on it,
  and one slim bar beneath carries control state plus Take/Return Control.
  `BotBrowserDiagnostic.mounted.test.tsx` exercises hung-input teardown through
  real mounted Stop, hidden-surface, and Return Control interactions;
  `botHumanInputBuffer.ts` coalesces hover/wheel traffic while preserving held
  movement and never discarding down/up events; `BotBrowserDiagnostic.tsx`
  polls typed computer diagnostics only during visible owned control, shows
  actionable cookie/dependency/display/site warnings with masked path/count and
  prerequisite facts, reports handled dialogs/open popups, and renders durable
  control waits with an owner-only Return Control action and no controller IDs;
  `mjpegStream.ts` and `botComputerCoordinates.ts` keep binary parsing and
  object-contain coordinate mapping outside React/store hot paths.
- `chat/BotResultAttachments.tsx` preserves encrypted generated-image mappings
  across all Shared-copy states and exposes verified loading, decoded, and
  retryable-error previews. `BotChatView.tsx` surfaces durable browser waits
  without putting action metadata in the assistant response.
- `botPresentation.ts` owns pure runtime-copy, revision-marker, action-target,
  run-label, failure-message, key-handling, and control-lease projections used by components and
  focused tests.
- `useBotRuntimeOperation.ts` projects Electron's authoritative lifecycle
  snapshot and window-scoped safe progress event into the chat and Bot settings
  recovery surfaces. Those components do not infer a long-running Docker
  operation from local click state, so reloads and failures retain accurate
  phase/error behavior without disturbing composer drafts or attachments.
- Components consume `useBotsStore`, `useBotChannelStore`,
  `useBotDraftStore`, `useBotComputerActivityStore`, `useBotOperationsStore`, and `useBotSharedFilesStore` through narrow
  selectors. Shared copy-state events update one file leaf; screencast pixels
  bypass stores entirely.
- Exact Confirmation navigation lives in a separate low-frequency store, and
  row focus/scroll runs only when the requested panel is active.

## Flow

1. `SessionSidebar` renders exactly one audience panel. `BotSidebarSection`
   selects a Bot without touching ordinary session state and ensures the current
   principal's owner channel.
   `BotView` then resolves host support, the selected Bot, and its authorized channel.
3. `BotChatView` loads canonical messages and renders conversation groups,
   composer, and explicit run state. `chat/BotIdentityHeader.tsx` owns the
   content-driven Bot identity presentation while the layout edge chrome owns
   sidebar controls.
4. `RightSidebarTabs` selects repository tabs for Agents and
   `BotOperationsRail` for Bots from the active audience.
5. `apps/botEventConnection.ts` closes and recreates failed Bot SSE sources;
   only a fresh snapshot restores Connected and refreshes the active canonical
   transcript. Snapshots/events then update finalized previews and dedicated stores;
   leaf subscriptions update only the
   affected rows and controls.

## Integration

- Lazy view boundary: `components/views/BotView.tsx` and `lazyViews.tsx`
- Shell mode: `components/layout/MainLayout.tsx`, `Header.tsx`,
- Navigation: `components/session/SessionSidebar.tsx`
- Audience tabs/state: `components/shared/ProductAudienceTabs.tsx` and
  `stores/useMainSidebarAudienceStore.ts`
- Transport/state: `lib/botsApi.ts`, `lib/botsDesktopApi.ts`, and
  `stores/useBot*Store.ts`

## Where to change things

- Bot navigation row or selection behavior: `sidebar/`
- Shared Bot profile avatar rendering: `BotAvatar.tsx`
- Canonical transcript grouping, identity presentation, or composer: `chat/`;
  Bot sidebar edge controls: `components/layout/`
- Current run, confirmations, Shared files, or diagnostic control: `operations/`
- Host-wide hidden surfaces in Bot mode: `components/layout/`
- Capability, channel, or event semantics: `lib/botsApi.ts` and
  `stores/useBot*Store.ts`; EventSource lifecycle/retry semantics:
  `apps/botEventConnection.ts` and `apps/BotsEventOwner.tsx`
- Overview, Resources, Memory, membership, routines, lifecycle, or deletion UI:
  `components/sections/bots/`
- Computer resource import, Finder reveal, and filesystem browsing:
  `components/sections/bots/BotComputerFiles.tsx` (views: Shared & Resources
  by default, Whole Workspace, and Whole Computer for global administrators via
  `botComputerFilesView.ts`)
- Write-only Bot environment names and add/rotate/delete controls:
  `components/sections/bots/BotEnvironmentSecrets.tsx`
- Optional per-Bot Skills/SOPs: `components/sections/bots/BotSkills.tsx`
- Protected provider API keys/accounts: `components/sections/bots/BotCredentials.tsx`
