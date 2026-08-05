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

- `toolExpandedFallback.ts`
  - Selects the first meaningful expandable representation without losing secondary failure state.
  - Precedence is structured diff/diagnostics, formatted input, provider output, provider failure, then an explicit no-details state.
  - Empty-state copy is terminal-only; partial output may render while a tool is still running.

- `TaskToolSummary.tsx` + `taskToolUtils.ts`
  - Preserve provider-native subagent output across failure and cancellation.
  - Failed or cancelled output is labelled as partial, retains its provider status/reason, and never receives a success check.

- `toolPresentation.tsx`
  - Shared icon mapping for tool names (`getToolIcon`).
  - Used by both `ProgressiveGroup.tsx` and `ToolPart.tsx`.

- `toolRenderUtils.ts`
  - Core classification helpers:
    - `isExpandableTool`
    - `isStaticTool`
    - `isStandaloneTool`
    - `getStaticGroupToolName`
  - If a tool should switch between static vs expandable, change it here.

- `ReasoningPart.tsx`
  - Renders reasoning Markdown directly in the message timeline while streaming and after completion.
  - Empty active reasoning retains the accessible, reduced-motion-aware `Thinking…` status until text arrives.
  - At the OpenAI-only render boundary, projects the provider summary to the rationale level captured in the turn's first user message and adds terminal punctuation to standalone plain or fully bold summary sentences. Headings, lists, code, links, multiline blocks, persisted parts, and non-OpenAI reasoning remain untouched.
  - The global reasoning visibility setting remains the sole display gate.
- `reasoningSummaryDisplay.ts`
  - Owns the pure OpenAI summary projection and punctuation rules used by `ReasoningPart.tsx`.

- `JustificationBlock.tsx`
  - Renders provider-authored intermediate narration in the compact activity timeline using normal assistant typography and foreground color. Only runtime `reasoning` parts use the muted reasoning presentation.
  - Turn projection classifies non-final `text` from tool/non-stop assistant steps as justification in both Live and Sorted modes; final `stop` text remains normal assistant Markdown.
  - Preserves natural Markdown and streaming updates. A leading bold activity title that is directly joined to prose receives render-only paragraph separation; persisted and copied message text remain unchanged.

## Current important behavior

- `read` and most search/fetch tools are treated as **static tools** and passive lookup activity rolls up across reasoning text into one dropdown per kind until a hard tool boundary such as shell/question/task.
- `bash/edit/write/question/task` are **expandable tools** and render via `ToolPart`.
- Output-only `write/create/file_write` aliases remain expandable even when no structured diff is available.
- Terminal tool failures remain visible alongside retained partial output. A genuinely empty terminal payload renders an explicit provider-no-details message instead of an empty expansion.
- `perplexity` is currently treated as static and grouped into search/web-search style rows (through static grouping + short description extraction).
- Reasoning remains inline across streaming/completion and respects the global reasoning visibility setting. Rationale Display affects only the presentation depth of OpenAI's provider-generated summary; it never exposes hidden chain-of-thought or mutates persisted message data.
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
- Reasoning/justification: `ReasoningPart.tsx`, `JustificationBlock.tsx`
- Status/placeholders: `WorkingPlaceholder.tsx`, `SessionActiveSpinner.tsx`, `MigratingPart.tsx`, `BusyDots.tsx`
- Utility renderers: `VirtualizedCodeBlock.tsx`, `MinDurationShineText.tsx`
