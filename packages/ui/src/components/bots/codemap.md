# packages/ui/src/components/bots/

## Responsibility

Private Production Bot navigation, continuous canonical chat, and the Bot
Operations rail shared by the web and Electron renderers, plus the deliberate
unsupported VS Code presentation. Bot configuration lives separately in
`components/sections/bots/` and calls the management contracts in
`lib/botsApi.ts`.

## Design

- `BotAvatar.tsx` is the shared profile-identity primitive for navigation,
  canonical chat, and Bot settings. It renders the authenticated avatar
  URL, then the configured fallback, then generated initials.
- `sidebar/` owns recency-ranked assigned-Bot conversation rows driven by
  finalized channel previews. The audience boundary is shared with
  `components/shared/ProductAudienceTabs.tsx` and the narrow session-only
  `stores/useMainSidebarAudienceStore.ts`.
- `chat/` owns conventional left/right grouped message presentation, the
  retained composer, and the avatar-level typing indicator shown before a Bot's
  first visible response content and at every tool boundary until the one result
  bubble resumes. Historical acknowledgment rows stay hidden. The composer performs atomic optimistic local
  echo and short acceptance locking. `chat/botAttachmentUpload.ts` owns the
  supported private-file catalog, browser MIME normalization, limits, and
  sequential partial-success handling for multi-file selections; live assistant
  rows read only the narrow requester-stream store. `chat/BotResultAttachments.tsx`
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
- `chat/BotMessageRow.tsx` keeps governed action metadata and controls out of
  assistant responses. Current run and confirmation state remains available in
  the separate Operations rail without adding tool-status rows to the transcript.
- `operations/` owns the current run summary, confirmations/reconciliation,
  conversation Shared files, and the ephemeral live-computer diagnostic.
- `botPresentation.ts` owns pure runtime-copy, revision-marker, action-target,
  run-label, key-handling, and control-lease projections used by components and
  focused tests.
- `useBotRuntimeOperation.ts` projects Electron's authoritative lifecycle
  snapshot and window-scoped safe progress event into the chat and Bot settings
  recovery surfaces. Those components do not infer a long-running Docker
  operation from local click state, so reloads and failures retain accurate
  phase/error behavior without disturbing composer drafts or attachments.
- Components consume `useBotsStore`, `useBotChannelStore`,
  `useBotOperationsStore`, and `useBotSharedFilesStore` through narrow
  selectors. Shared copy-state events update one file leaf; screencast pixels
  bypass stores entirely.
- Exact Confirmation navigation lives in a separate low-frequency store, and
  row focus/scroll runs only when the requested panel is active.

## Flow

1. `SessionSidebar` renders exactly one audience panel. `BotSidebarSection`
   selects a Bot without touching ordinary session state and ensures the current
   principal's owner channel.
2. `MainLayout`/`VSCodeLayout` derive Bot mode from the audience switch;
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
  `RightSidebarTabs.tsx`, and `VSCodeLayout.tsx`
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
  `components/sections/bots/BotComputerFiles.tsx`
- Write-only Bot environment names and add/rotate/delete controls:
  `components/sections/bots/BotEnvironmentSecrets.tsx`
- Optional per-Bot Skills/SOPs: `components/sections/bots/BotSkills.tsx`
- Protected provider API keys/accounts: `components/sections/bots/BotCredentials.tsx`
