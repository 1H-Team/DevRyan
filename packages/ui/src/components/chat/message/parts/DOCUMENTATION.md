# Chat Message Parts: Rendering Architecture

This folder contains renderers for chat message parts (text, tools, reasoning, placeholders) and shared tool presentation helpers.

Use this doc when you ask an agent to change tool/header/description behavior.

## High-level flow

- Message parts are rendered from `MessageBody.tsx`.
- There are two tool rendering paths:
  - **Static grouped tools** -> `StaticToolRow` in `ProgressiveGroup.tsx`
  - **Expandable tools** -> `ToolPart.tsx`
- Shared tool icon mapping is centralized in `toolPresentation.tsx` (`getToolIcon`).

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

- `TaskToolSummary.tsx` + `taskToolUtils.ts`
  - Preserve provider-native subagent output across failure and cancellation.
  - Failed or cancelled output is labelled as partial, retains its provider status/reason, and never receives a success check.
  - The observed Cursor-native Agent Dispatch row reuses this bounded summary renderer for nested activity and terminal output. `MessageBody.tsx` suppresses the ordinary raw task row only when the runtime-owned, versioned Cursor projection is valid; malformed or unprojected task tools keep the standard expandable renderer.

- `toolPresentation.tsx`
  - Shared icon mapping for tool names (`getToolIcon`).
  - Used by both `ProgressiveGroup.tsx` and `ToolPart.tsx`.

- `generatedImageResults.ts` + `GeneratedImageResult.tsx`
  - Project at most twelve PNG/JPEG/GIF/WebP candidates from a completed assistant response, preserving Markdown order and appending finalized unlinked image-tool output.
  - `AssistantTextPart` strips image-loading Markdown so only the final assistant sibling owns one responsive gallery; tool rows never render a second preview.
  - The gallery is recovery-aware lazy code, observes a 640 px viewport margin, then prepares local web/Electron files through the message-scoped authorization route. VS Code marks gallery raw requests as workspace-only, while remote/data images load directly in the renderer.
  - Every image is fetched into an abortable object URL and revoked on cleanup. Ready buttons reuse the existing single-image popup without carousel state; failed local files can open in the editor and failed remote images retain a no-referrer external link.

- `toolRenderUtils.ts`
  - Core classification helpers:
    - `isExpandableTool`
    - `isStaticTool`
    - `isStandaloneTool`
    - `getStaticGroupToolName`
  - If a tool should switch between static vs expandable, change it here.

- `ReasoningPart.tsx`
  - Renders one provider reasoning part's Markdown inside an expanded `ReasoningGroup`; collapsed disclosures do not mount or parse hidden Markdown.
  - Empty terminal reasoning renders nothing. An empty active part may still give its group enough lifecycle state to render the compact `Thinking…` disclosure.
  - Reasoning text stays static and readable while streaming; shimmer is reserved for transient bottom-status copy rather than semantic model output.
  - At the OpenAI-only render boundary, projects the provider summary to the rationale level captured in the turn's first user message and adds terminal punctuation to standalone plain or fully bold summary sentences. Headings, lists, code, links, multiline blocks, persisted parts, and non-OpenAI reasoning remain untouched by that formatting projection.
  - The global reasoning visibility setting remains the user-controlled display gate. A narrow compatibility policy also suppresses finalized xAI summaries whose trimmed text has the confirmed clipped fingerprint of exactly 203 characters ending in ASCII `...`; unfinished or differently shaped summaries fail open.
- `ReasoningGroup.tsx` + `reasoningGrouping.ts` + `reasoningDuration.ts`
  - Every reasoning run uses the same adaptive presentation in Live and Sorted modes. Active runs remain a collapsed disclosure. A completed displayable singleton renders inline when its duration is unavailable or under 15 seconds; it becomes a collapsed disclosure at 15 seconds or longer. Two or more displayable adjacent parts always share one collapsed disclosure. Tools and normal text end the run, so reasoning/tool/reasoning remains in natural source order.
  - The trailing reasoning run stays active while its owning message/turn is live, including the provider gap where one part has ended immediately before the next is announced. A newer semantic row ends that ownership deterministically; no debounce or persisted heuristic is involved.
  - Active disclosures say `Thinking…`. Terminal disclosures say `Thought for {duration}` when every displayed part has a finite, non-negative start/end pair; the duration is the run's earliest-start-to-latest-end wall-clock span rounded to whole seconds, with an exact zero-length provider timestamp rendered as `<1s`. Missing, incomplete, reversed, negative, or non-finite timing renders plain `Thought` when a multi-part disclosure still applies.
  - While a disclosure remains applicable, only explicit user input changes expansion. Pointer activation plus Enter/Space keyboard activation share the same controlled state path; appending parts, ending the run, completing/aborting the message, and reduced-motion preferences do not change `aria-expanded` or trigger a completion collapse. A short completed singleton intentionally leaves disclosure presentation and becomes inline content.
  - Expanded content renders every displayable reasoning part in source order. Collapsed content is not mounted, avoiding hidden streaming Markdown work.
  - Known clipped xAI previews are removed before group membership, disclosure counts, and Sorted activity preview counts are derived, so they cannot leave empty rows or Activity headers.
  - Suppression is render-only: canonical parts remain available to synchronization, plan extraction, lifecycle state, persistence, and diagnostics.
- `reasoningDisclosureStatus.ts`
  - Registers only mounted active disclosures by session. The bottom status row consumes this narrow external-store leaf to suppress duplicate thinking text while preserving its fixed space, warnings, stall recovery, and safety controls.
  - Ownership is reference-counted and cleaned up on completion, hiding, session changes, and unmount, so stale historical state cannot suppress a later status row.
- `reasoningSummaryDisplay.ts`
  - Owns the pure OpenAI summary projection and punctuation rules used by `ReasoningPart.tsx`.

- `JustificationBlock.tsx`
  - Renders provider-authored intermediate narration in the compact activity timeline using normal assistant typography and foreground color. Only runtime `reasoning` parts use the muted reasoning presentation.
  - Turn projection classifies non-final `text` from tool/non-stop assistant steps as justification in both Live and Sorted modes; final `stop` text remains normal assistant Markdown.
  - Preserves natural Markdown and streaming updates. A leading bold activity title that is directly joined to prose receives render-only paragraph separation; persisted and copied message text remain unchanged.

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

`PlanCardSkeleton.tsx` keeps the existing 8–48 line layout reservation, but the
line group owns one opacity animation instead of every line owning pulse and
sweep animations. `useDocumentAnimationState()` is a module-level external
store with one shared document-visibility listener and one shared
reduced-motion listener. It is not Zustand state. The bottom status keeps its
accessible label in flow while the proven foreground-gradient text layer
supplies the shimmer sweep; status changes update that stable node without a
keyed vertical transition. The plan skeleton, bottom status shimmer, retry
countdown, and active duration labels pause while hidden; labels recompute on
foreground. Reduced-motion presentation remains readable without a long-lived
animation; the reasoning disclosure also disables both its panel animation and
chevron transition while preserving the same user-controlled open state.
`SessionActiveSpinner.tsx` is not mounted in the current chat tree
and is outside this performance contract.

- `read` and most search/fetch tools are treated as **static tools** and passive lookup activity rolls up across reasoning text into one dropdown per kind until a hard tool boundary such as shell/question/task.
- `bash/edit/write/question/task` are **expandable tools** and render via `ToolPart`.
- Bash rows show the bounded terminal transcript and a shared elapsed duration (`0.1s`, `m s`, or `h m s`). Active duration ticks are isolated to their narrow leaves; completed durations use stable start/end timestamps and invalid timing renders `Unavailable`.
- Output-only `write/create/file_write` aliases remain expandable even when no structured diff is available.
- Terminal tool failures remain visible alongside retained partial output. A genuinely empty terminal payload renders an explicit provider-no-details message instead of an empty expansion.
- `perplexity` is currently treated as static and grouped into search/web-search style rows (through static grouping + short description extraction).
- Reasoning respects the global reasoning visibility setting. Each contiguous run is collapsed as `Thinking…` while live. After termination, one displayable thought is shown inline unless its trusted duration is at least 15 seconds; adjacent multi-part runs always remain one collapsed `Thought for …` disclosure (or `Thought` without trustworthy timing). Finalized xAI summaries matching the exact 203-character clipped-preview fingerprint are omitted before the presentation count is derived without mutating persisted message data. Rationale Display affects only the presentation depth of OpenAI's provider-generated summary; it never exposes hidden chain-of-thought or mutates persisted message data.
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

- Text: `AssistantTextPart.tsx`, `UserTextPart.tsx`
- Tools: `ToolPart.tsx`, `ProgressiveGroup.tsx`, `toolPresentation.tsx`, `toolRenderUtils.ts`, `ToolRevealOnMount.tsx`
- Reasoning/justification: `ReasoningPart.tsx`, `ReasoningGroup.tsx`, `reasoningGrouping.ts`, `reasoningDuration.ts`, `reasoningDisclosureKeyboard.ts`, `reasoningDisclosureStatus.ts`, `JustificationBlock.tsx`
- Status/placeholders: `WorkingPlaceholder.tsx`, `SessionActiveSpinner.tsx`, `MigratingPart.tsx`
- Utility renderers: `VirtualizedCodeBlock.tsx`, `MinDurationShineText.tsx`, `useNearViewport.ts`
