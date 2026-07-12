# Full Reasoning Output Design

## Problem

When reasoning traces are enabled, DevRyan does not consistently show the complete reasoning emitted by a model. The loss is not limited to Cursor-backed models:

- The sync pipeline applies semantic reasoning cleanup to every `reasoning` part, regardless of provider. This can delete valid ChatGPT and other provider output before it reaches the renderer.
- `ReasoningPart` applies the same cleanup again while rendering.
- Sorted chat rendering projects reasoning into the collapsible activity group, where the collapsed preview keeps only the last seven rows.
- Cursor-backed reasoning receives an additional provider-specific collapsed `<details>` presentation.

These behaviors make the “Show reasoning traces” setting misleading: enabling it does not guarantee that the complete available trace is visible.

## Goal

When “Show reasoning traces” is enabled, display every reasoning part supplied by the runtime, inline and in message order, for every provider. When the setting is disabled, hide reasoning as it does today.

## Non-goals

- Recover reasoning that a provider or OpenCode never sends.
- Expose private or unavailable chain-of-thought beyond the reasoning parts present in the runtime payload.
- Add a second expanded/collapsed reasoning preference.
- Change tool grouping, tool expansion defaults, final-answer rendering, or model thinking-effort selection.
- Change the OpenCode HTTP/SSE contract or add dependencies.

## Design

### Preserve authoritative reasoning in synchronization

Reasoning parts must keep model-authored text intact across initial message fetches, direct part updates, queued streaming deltas, and event-reducer updates. Provider-neutral sync code may continue mechanical transport repair that is independent of prose meaning:

- collapse an exact adjacent replay of a sufficiently long frame;
- remove explicit internal tool-runner diagnostics that are not model-authored reasoning.

Sync code must stop deleting text based on semantic sentence patterns, including user-intent restatements, skill/action narration, skill-announcement discussion, headings, and dangling list markers. Those rules cannot reliably distinguish unwanted Cursor narration from valid reasoning emitted by ChatGPT or another provider.

`normalizeAssistantReasoningText` will therefore become loss-preserving apart from the same mechanical normalization allowed for visible assistant text. Obsolete semantic-only helpers and their tests will be removed or replaced with preservation tests.

### Normalize once, render without rewriting

`ReasoningPart` will perform presentation-only whitespace cleanup, such as removing quote prefixes and empty lines, but it will not call sync normalization or remove sentences. The synchronized part text is the renderer’s source of truth.

This boundary prevents rendering behavior from silently changing stored content and avoids applying destructive cleanup twice.

### Keep reasoning outside collapsible tool previews

In both live and sorted chat modes, reasoning will render inline at the position of its owning message. Sorted activity groups may still contain and collapse tool or justification activity, but reasoning rows will not be consumed by the group or limited by its seven-row preview.

The activity projection may continue tracking reasoning for status, ordering, and completion calculations. At render time, grouped activity segments will exclude reasoning rows and the normal message-part loop will render each reasoning part exactly once. This preserves existing turn-state behavior without duplicating output.

### Remove provider-specific collapsing

All providers will use the same inline `ReasoningTimelineBlock`. The Cursor metadata check, compact prop, collapsed `<details>` branch, and compact-only data attributes will be removed.

An active reasoning part with no text will continue to show the existing “Thinking…” status. Once text arrives, the complete accumulated text will stream through the existing throttled renderer.

### Visibility setting

`showReasoningTraces` remains the single visibility gate:

- enabled: every available reasoning part renders inline;
- disabled: reasoning parts do not render in either the message body or grouped activity.

The setting default and persistence contract remain unchanged.

## Data flow

1. OpenCode or another supported runtime supplies a `reasoning` part through message fetch or live events.
2. The sync layer performs only mechanical transport normalization and stores the complete model-authored text.
3. Turn projection may reference the reasoning part for activity and completion state.
4. The message renderer checks `showReasoningTraces`.
5. If enabled, `ReasoningPart` renders the text inline exactly once at its message position, independent of provider and tool-group expansion.

## Error and edge-case handling

- Empty active reasoning continues to render “Thinking…”. Empty completed reasoning renders nothing.
- Replayed streaming frames remain deduplicated by the existing mechanical duplicate guard.
- Explicit internal tool-runner diagnostics remain suppressed.
- Multiple reasoning parts separated by tool calls remain separate and ordered.
- Historical fetched messages and live-streamed messages use the same preservation rule.
- If the upstream runtime omits or redacts reasoning, DevRyan shows only what it receives and does not synthesize missing text.

## Testing

Focused tests will prove:

- semantic lines previously removed from reasoning are preserved;
- mechanical duplicate and internal-diagnostic cleanup still works;
- message fetch, pending deltas, and event reduction retain complete non-Cursor reasoning;
- Cursor and non-Cursor reasoning use the same inline renderer with no `<details>` disclosure;
- sorted activity rendering excludes reasoning from collapsed previews and renders each reasoning part once inline;
- disabling `showReasoningTraces` still hides reasoning;
- active empty reasoning still displays the working indicator.

Run the focused Bun tests first, then `bun run validate:affected` because this changes shared UI sync and chat rendering used by web, Electron, and VS Code.

## Files expected to change

- `packages/ui/src/sync/part-delta.ts`
- `packages/ui/src/sync/part-delta.test.ts`
- `packages/ui/src/sync/message-fetch.test.ts`
- `packages/ui/src/sync/pending-part-deltas.test.ts`
- `packages/ui/src/sync/__tests__/event-reducer.test.ts`
- `packages/ui/src/components/chat/message/parts/ReasoningPart.tsx`
- `packages/ui/src/components/chat/message/parts/ReasoningPart.test.tsx`
- `packages/ui/src/components/chat/message/MessageBody.tsx`
- A focused message-rendering regression test near `MessageBody.tsx`, created if no existing test provides the required coverage.

No server, Electron shell, legacy Tauri, or VS Code-specific implementation change is expected because all affected runtimes consume the shared UI.
