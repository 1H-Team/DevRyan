# Chat Message Parts: Rendering Architecture

This folder contains renderers for chat message parts (text, tools, reasoning, placeholders) and shared tool presentation helpers.

`PlanCard` keeps its unfinished-response and already-started disabled reasons available through the button's accessible description and tooltip, but hides these duplicate status labels visually. Completion, saved-source validation, duplicate-start protection, and actionable failure messages are unchanged. The isolated chat fixture checks both states with the real component.

Use this doc when you ask an agent to change tool/header/description behavior.

## Tool diff preview budget

`toolDiffPreview.ts` checks each raw source before normalization, file splitting, rich parsing or highlighting. A preview ends at 2,000 content lines or 262,144 UTF-16 code units, whichever arrives first. LF, CRLF and CR are recognized; a final line terminator does not add a content line, and truncation never bisects CRLF or a surrogate pair. Oversized combined patches remain one plain-text entry. Header counts and line navigation also obey this guard; supplied metadata counts remain authoritative, while unknown full-patch totals stay absent.

`RawPatchFallback.tsx` applies the same policy to malformed patches and renderer failures. Its localized notice and download button precede the preview so the action is immediately discoverable. The source stays unchanged. `toolDiffDownload.ts` downloads the complete source as `DevRyan-tool-diff.patch` and revokes the object URL after one second. Oversized write inputs render only bounded content; clicking Download constructs the complete synthetic patch using the existing write-patch format. There is no unbounded in-app override or persisted setting.

`tests/visual-chat-improvements/` exercises production ToolPart/MessageBody components with isolated sync stores, verifies full download bytes and URL revocation, injects a rich-renderer failure, checks question/plan placement, and counts composer-history commits. Its clipboard endpoint is simulated to leave the system clipboard untouched.

## High-level flow

- Message parts are rendered from `MessageBody.tsx`.
- There are two tool rendering paths:
  - **Static grouped tools** -> `StaticToolRow` in `ProgressiveGroup.tsx`
  - **Expandable tools** -> `ToolPart.tsx`
- Shared tool icon mapping is centralized in `toolPresentation.tsx` (`getToolIcon`).

Turn headers prefer the first substantive assistant output over leading
error-only rows; an error-only turn retains its header and all errors remain
visible. Header effort uses the owning assistant's recorded variant, then its
own parent's variant, before the original turn fallback. Explicit default
effort does not inherit an earlier attempt's level.
Headers retain the recorded model ID while its catalog entry is unavailable
and subscribe only to that provider's catalog record, so a later catalog name
updates an existing header without replaying messages or changing the model.

## Which file controls what

- `ProgressiveGroup.tsx`
  - Renders grouped Activity rows and grouped static tools.
  - Contains `StaticToolRow`.
  - Contains static tool short description logic (`getToolShortDescription`).
  - If you want to change how `read/grep/perplexity/webfetch/...` look in compact/grouped mode, edit here.

- `ToolPart.tsx`
  - Renders expandable tool rows (bash/edit/write/question/task + fallback).
  - Controls expandable header title/description/diff stats/timer and expanded output body.
  - If you want to change expandable tool layout, edit here.

- `terminalTranscript.ts`
  - Incrementally renders Bash output as terminal state instead of raw escape text.
  - Handles carriage-return rewrites, backspace/tabs, supported CSI cursor and erase commands, SGR suppression, bounded OSC/control sequences, and parser state split across streaming chunks.
  - Retains at most a 1 MiB raw tail and a 256 KiB / 5,000-line rendered tail, adding a visible truncation marker when earlier output is dropped.

- `ToolScrollableSection.tsx`
  - Follows streaming Bash output only while the viewport is within 24 px of the bottom.
  - Wheel/touch/keyboard upward intent immediately releases the pin; `useLayoutEffect` performs follow adjustments before paint and native scroll anchoring is disabled.
  - `toolScrollFollow.ts` owns the pure bottom-threshold calculation used by the component and its tests.

- `toolExpandedFallback.ts`
  - Selects the first meaningful expandable representation without losing secondary failure state.
  - Precedence is structured diff/diagnostics, formatted input, provider output, provider failure, then an explicit no-details state.
  - Empty-state copy is terminal-only; partial output may render while a tool is still running.

- `TaskToolSummary.tsx` + `taskToolUtils.ts` + `TaskChildSessionSummary.tsx`
  - A collapsed sub-agent (`task`) card renders from its tool part alone: prompt, status, duration, the summary entries in its metadata, the result and the Open Subtask link. It subscribes to no child messages, so running sub-agents never re-render or retain the parent transcript's cards. Opening the card mounts `TaskChildSessionSummary`, which loads, follows and polls the child session's tool activity until the card closes. Managed dispatch rows (`ManagedTaskList`) render from the managed-task projection and never load child messages.
  - Preserve provider-native subagent output across failure and cancellation.
  - Failed or cancelled output is labelled as partial, retains its provider status/reason, and never receives a success check.
  - The observed Cursor-native Agent Dispatch row reuses this bounded summary renderer for nested activity and terminal output. `MessageBody.tsx` suppresses the ordinary raw task row only when the runtime-owned, versioned Cursor projection is valid; malformed or unprojected task tools keep the standard expandable renderer.

- `toolPresentation.tsx`
  - Shared icon mapping for tool names (`getToolIcon`).
  - Used by both `ProgressiveGroup.tsx` and `ToolPart.tsx`.

- `generatedImageResults.ts` + `GeneratedImageResult.tsx`
  - Project at most twelve PNG/JPEG/GIF/WebP candidates from a completed assistant response, preserving Markdown order and appending finalized unlinked image-tool output.
  - `AssistantTextPart` strips image-loading Markdown so only the final assistant sibling owns one responsive gallery; tool rows never render a second preview.
  - The gallery is recovery-aware lazy code, observes a 640 px viewport margin, then prepares local web/Electron files through the message-scoped authorization route. Remote/data images load directly in the renderer.
  - Every image is fetched into an abortable object URL and revoked on cleanup. Ready buttons reuse the existing single-image popup without carousel state; failed local files can open in the editor and failed remote images retain a no-referrer external link.

- `toolRenderUtils.ts`
  - Core classification helpers:
    - `isExpandableTool`
    - `isStaticTool`
    - `isStandaloneTool`
    - `getStaticGroupToolName`
  - If a tool should switch between static vs expandable, change it here.

- `ReasoningPart.tsx`
  - Renders one provider reasoning part's Markdown inside an expanded `ReasoningGroup`; collapsed disclosures do not mount or parse hidden Markdown. A readable escaped-text fallback covers lazy renderer loading, avoiding an empty first expansion.
  - Empty terminal reasoning renders nothing. Empty active reasoning gives its group enough lifecycle state to render a non-expandable `Thinking…` status; only displayable content exposes a disclosure. Authoritative message completion also terminalizes the text projection when cancellation leaves a part without an end timestamp.
  - Reasoning text stays static and readable while streaming; shimmer is reserved for transient bottom-status copy rather than semantic model output.
  - At the OpenAI-only render boundary, projects the provider summary to the rationale level captured in the turn's first user message and adds terminal punctuation to standalone plain or fully bold summary sentences. Headings, lists, code, links, multiline blocks, persisted parts, and non-OpenAI reasoning remain untouched by that formatting projection.
  - The global reasoning visibility setting remains the user-controlled display gate. A narrow compatibility policy also suppresses finalized xAI summaries whose trimmed text has the confirmed clipped fingerprint of exactly 203 characters ending in ASCII `...`; unfinished or differently shaped summaries fail open.
- `ReasoningGroup.tsx` + `reasoningGrouping.ts` + `reasoningDuration.ts`
  - Every reasoning run uses the same adaptive presentation in Live and Sorted modes. Active runs without displayable text render an accessible non-expandable status. The first displayable content promotes that status to a collapsed disclosure without moving focus. A completed displayable singleton renders inline when its duration is unavailable or under 15 seconds; it becomes a collapsed disclosure at 15 seconds or longer. Two or more displayable adjacent parts always share one collapsed disclosure. Tools and normal text end the run, so reasoning/tool/reasoning remains in natural source order.
  - The trailing reasoning run stays active while its owning message/turn is live, including the provider gap where one part has ended immediately before the next is announced. A newer semantic row ends that ownership deterministically; no debounce or persisted heuristic is involved.
  - Active disclosures say `Thinking…`. Terminal disclosures say `Thought for {duration}` when every displayed part has a finite, non-negative start/end pair; the duration is the run's earliest-start-to-latest-end wall-clock span rounded to whole seconds, with an exact zero-length provider timestamp rendered as `<1s`. Missing, incomplete, reversed, negative, or non-finite timing renders plain `Thought` when a multi-part disclosure still applies.
  - While a disclosure remains applicable, only explicit user input changes expansion. Pointer activation plus Enter/Space keyboard activation share the same controlled state path; appending parts, ending the run, completing/aborting the message, and reduced-motion preferences do not change `aria-expanded` or trigger a completion collapse. A short completed singleton intentionally leaves disclosure presentation and becomes inline content. `reasoningDisclosureExpansion.ts` retains explicit expansion across responsive layout and virtualized row remounts using the session, message, and first canonical part identity. This in-memory LRU holds only expanded choices, bounded by 4,000 entries and 512 KiB of keys; it does not store reasoning content, persist across app reloads, or notify shared-store subscribers.
  - Expanded content renders every displayable reasoning part in source order. Collapsed content is not mounted, avoiding hidden streaming Markdown work.
  - Known clipped xAI previews are removed before group membership, disclosure counts, and Sorted activity preview counts are derived, so they cannot leave empty rows or Activity headers.
  - Suppression is render-only: canonical parts remain available to synchronization, plan extraction, lifecycle state, persistence, and diagnostics.
- `reasoningDisclosureStatus.ts`
  - Registers only mounted active reasoning presentations (pending status or disclosure) by session. The bottom status row consumes this narrow external-store leaf to suppress duplicate thinking text while preserving its fixed space, warnings, stall recovery, and safety controls.
  - Ownership is reference-counted and cleaned up on completion, hiding, session changes, and unmount, so stale historical state cannot suppress a later status row.
- `reasoningSummaryDisplay.ts`
  - Owns the pure OpenAI summary projection and punctuation rules used by `ReasoningPart.tsx`.

- `JustificationBlock.tsx`
  - Renders provider-authored intermediate narration in the compact activity timeline using normal assistant typography and foreground color. Only runtime `reasoning` parts use the muted reasoning presentation.
  - Turn projection classifies non-final `text` from tool/non-stop assistant steps as justification in both Live and Sorted modes; final `stop` text remains normal assistant Markdown.
  - Preserves natural Markdown and streaming updates. A leading bold activity title that is directly joined to prose receives render-only paragraph separation; persisted and copied message text remain unchanged.

Native Cursor text uses its existing provider-state part identity for exact
render/copy preservation. Adjacent distinct Cursor parts are neither collapsed
by string similarity nor joined with fabricated whitespace; whitespace-only
seams survive. Content-based legacy status/orphan narration cleanup does not
discard those published parts. Typed tool/reasoning structure remains separate.

## Current important behavior

### Streaming paint ownership

Canonical SSE reduction and the 24 ms event pipeline remain unthrottled by the
part renderers. `useStreamingTextThrottle` owns only the visible projection for
assistant text, reasoning, justification, and plan Markdown. Each identity
renders its first non-empty text synchronously, trailing-coalesces intermediate
growth to the latest value at most once per 32 ms, and renders terminal text
immediately after canceling pending work. Temporary shorter streaming snapshots
cannot truncate visible text; terminal text is authoritative. Copy/export,
notifications, status, tool state, scrolling, and persisted sync text always
read canonical state rather than the paint projection.

### Presentation animation ownership

Always-visible working chrome animates only `opacity` and `transform`, which
the compositor runs without main-thread style, layout or paint. The bottom status
shimmer is a masked window (`.oc-text-shimmer-sweep`) that slides across the
label while its generated-content copy of the text slides back by the same
distance, so the highlight sweeps without repainting text; the label itself is
the only text node. Sidebar and mobile working dots fade with
`.animate-session-working-blink`, the plan skeleton's line group owns one
opacity animation, the active reasoning header pulses and the context-usage and
mobile sub-session loaders spin. Do not animate `background-position`, colors or
other painted properties in always-visible working chrome: they repaint every
frame. `PlanCardSkeleton.tsx` keeps the existing 8–48 line layout reservation.
`useDocumentAnimationState()` is a module-level external store with one shared
document-visibility listener and one shared reduced-motion listener. It is not
Zustand state. The bottom status keeps one accessible label in flow; status
changes update that stable node without a keyed vertical transition. The plan
skeleton, bottom status shimmer, retry
countdown, and active duration labels pause while hidden; labels recompute on
foreground. Reduced-motion presentation remains readable without a long-lived
animation; the reasoning disclosure also disables both its panel animation and
chevron transition while preserving the same user-controlled open state.
`SessionActiveSpinner.tsx` is not mounted in the current chat tree
and is outside this performance contract.

- `read` and most search/fetch tools are treated as **static tools** and passive lookup activity rolls up across reasoning text into one dropdown per kind until a hard tool boundary such as shell/question/task.
- Skill calls keep individual part identities in both render modes. Their names use static text throughout loading and completion; an unknown pending name leaves only the loading status until the runtime supplies a human name. Completing a call updates the existing status node rather than remounting it. Sorted mode retains its normal seven-row collapsed preview.
- `bash/edit/write/question/task` are **expandable tools** and render via `ToolPart`.
- Bash rows show the bounded terminal transcript and a shared elapsed duration (`0.1s`, `m s`, or `h m s`). Active duration ticks are isolated to their narrow leaves; completed durations use stable start/end timestamps and invalid timing renders `Unavailable`.
- Output-only `write/create/file_write` aliases remain expandable even when no structured diff is available.
- Terminal tool failures remain visible alongside retained partial output. A genuinely empty terminal payload renders an explicit provider-no-details message instead of an empty expansion.
- `perplexity` is currently treated as static and grouped into search/web-search style rows (through static grouping + short description extraction).
- Reasoning respects the global reasoning visibility setting. Each contiguous run shows `Thinking…` while live, as a passive status until text arrives and then as a collapsed disclosure. After termination, one displayable thought is shown inline unless its trusted duration is at least 15 seconds; adjacent multi-part runs always remain one collapsed `Thought for …` disclosure (or `Thought` without trustworthy timing). Finalized xAI summaries containing only the confirmed 200-character prefix plus ASCII ellipsis are omitted before the presentation count is derived. When xAI appends a fuller summary to that preview, `reasoningSummaryDisplay.ts` removes only the clipped prefix during streaming and historical rendering, preserving the subsequent summary and its Markdown. Character counting respects Unicode; other ellipses and providers pass through. This is a display projection: canonical text and provider metadata remain intact, and text absent from the provider response cannot be recovered. Rationale Display affects only the presentation depth of OpenAI's provider-generated summary; it never exposes hidden chain-of-thought or mutates persisted message data.
- Provider-authored intermediate narration remains visible independently of the reasoning setting and uses normal assistant presentation in the compact activity hierarchy in both Live and Sorted modes. Tool adjacency and message finish reason never make visible assistant `text` look like reasoning.

## "I want to change description for Perplexity" (example recipe)

If task is: "change text shown near Perplexity tool header/description":

1. Edit `ProgressiveGroup.tsx` -> `getToolShortDescription(activity)`.
2. Update the branch that handles web-search tools (`websearch`, `web-search`, `search_web`, `codesearch`, `perplexity`, etc.).
3. If needed, update group rendering in `StaticToolRow` (search/fetch specific rendering branches).
4. Keep icon changes (if any) in `toolPresentation.tsx`.

Why: in current pipeline Perplexity is static/grouped, so `StaticToolRow` is the primary path.

## "I want tool to become expandable" (example)

1. Update `toolRenderUtils.ts`:
   - add/remove tool name in `EXPANDABLE_TOOL_NAMES`
2. Ensure `ToolPart.tsx` supports desired header + expanded output format for that tool.
3. Validate both modes (`sorted` and `live`).

## Safe editing checklist

- Do not duplicate icon logic; keep it in `toolPresentation.tsx`.
- For static tool copy changes, prefer `ProgressiveGroup.tsx` first.
- For expanded output changes, edit `ToolPart.tsx`.
- After edits run:
  - `bun run type-check`
  - `bun run lint`
  - `bun run build`

## Quick map of files in this folder

`PlanCard` keeps approval disabled until the saved current source is verified.
An explicit terminal error or unresolved persisted error/stopped notice bound
to the exact revision user, plus authoritative session idle, displays a failed
response explanation even when the failed native message lacks a completion
stamp. Busy/retry continuation still displays the pending explanation; neither
presentation grants implementation authority.

- Text: `AssistantTextPart.tsx`, `UserTextPart.tsx`
- Tools: `ToolPart.tsx`, `ProgressiveGroup.tsx`, `toolPresentation.tsx`, `toolRenderUtils.ts`, `ToolRevealOnMount.tsx`
- Reasoning/justification: `ReasoningPart.tsx`, `ReasoningGroup.tsx`, `reasoningGrouping.ts`, `reasoningDuration.ts`, `reasoningDisclosureKeyboard.ts`, `reasoningDisclosureStatus.ts`, `JustificationBlock.tsx`
- Status/placeholders: `WorkingPlaceholder.tsx`, `SessionActiveSpinner.tsx`, `MigratingPart.tsx`
- Utility renderers: `VirtualizedCodeBlock.tsx`, `MinDurationShineText.tsx`, `useNearViewport.ts`

Managed stopped tasks retain their canonical terminal status even while a user continues the child chat independently. A server-advertised stopped-recovery capability shows Resume as task with an explicit model/effort selection in the parent row and opened child. It also allows explicit dismissal, but never offers auto-resume for user cancellation. Canonical stop presentation takes precedence over the provider fallback for a `Step interrupted` assistant error.
