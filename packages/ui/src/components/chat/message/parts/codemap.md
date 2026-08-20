# packages/ui/src/components/chat/message/parts/

## Responsibility
Contains renderers for individual chat message part types (text, tool, attachments, etc.).

## Design
Part-dispatch pattern chooses a specialized renderer per part type.
Tool diff parsing lives in `toolPartDiffEntries.ts` so `ToolPart.tsx` remains a React-only component module for fast refresh.
Completed GPT Image Generation results are projected by `generatedImageResults.ts` and rendered by `GeneratedImageResult.tsx`; matching standalone assistant links become previews while unlinked results fall back beneath the tool row.
Tool-name normalization and description fallbacks, including glob-pattern labels propagated into grouped search rows, live in `tool-activity/classification.ts` and are re-exported through `toolRenderUtils.ts`.
`devryan_browser` is a dedicated passive turn-level activity: aggregation keeps canonical tool parts intact while presenting all browser commands across narration and assistant siblings as one non-expandable row anchored to the first call in both Live and Sorted modes.
Expandable fallback selection lives in `toolExpandedFallback.ts`; provider-native task result/failure projection lives in `taskToolUtils.ts` and is rendered by `TaskToolSummary.tsx`. `taskToolUtils.ts` also routes bounded linked-child message polls through the shared sync materializer so delayed HTTP snapshots cannot replace newer terminal SSE state or drop older cached child activity.
The observed Cursor-native Agent Dispatch projection reuses `TaskToolSummary.tsx` for its nested tool entries and terminal result. The normal raw task row is suppressed only after `../../cursorNativeTaskDispatch.ts` validates runtime-owned schema/version/source metadata.
`terminalTranscript.ts` incrementally projects Bash output into a bounded visible terminal transcript. `ToolScrollableSection.tsx` owns paint-synchronous bottom following that releases as soon as the user scrolls upward, while its pure threshold policy lives in `toolScrollFollow.ts` so the component remains Fast Refresh-safe.
`ReasoningGroup.tsx` collapses adjacent provider-normalized reasoning parts to the latest non-empty line, keeps earlier export roots mounted behind an accessible disclosure, and animates only genuine part-ID changes. `../reasoningGrouping.ts` owns the pure Live/Sorted grouping scans.
`../../hooks/useStreamingTextThrottle.ts` owns the 32 ms render-only text projection with immediate first/terminal updates. `PlanCardSkeleton.tsx`, `WorkingPlaceholder.tsx`, and `useDurationTicker.ts` consume the shared document animation state so presentation-only work pauses while hidden or under reduced motion; `workingPlaceholderTiming.ts` owns the retry countdown's boundary-aligned pure timing policy. `WorkingPlaceholder.tsx` keeps one status label in flow and sweeps a foreground-colored, aligned, aria-hidden duplicate with counter-transforms, so the shimmer remains visible while label updates avoid remounts and vertical layout transitions. `ProgressiveGroup.tsx` uses the chat timeline's responsive 8px mobile / 12px desktop gap between grouped skill and tool rows; expanded row details keep their own internal spacing.

## Flow
Message rows iterate parts and delegate rendering; part components format streaming updates safely.

## Integration
Used by chat/message components and backed by shared markdown/tool helpers.
