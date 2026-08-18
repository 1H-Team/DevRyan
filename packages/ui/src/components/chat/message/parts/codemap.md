# packages/ui/src/components/chat/message/parts/

## Responsibility
Contains renderers for individual chat message part types (text, tool, attachments, etc.).

## Design
Part-dispatch pattern chooses a specialized renderer per part type.
Tool diff parsing lives in `toolPartDiffEntries.ts` so `ToolPart.tsx` remains a React-only component module for fast refresh.
Tool-name normalization and description fallbacks, including glob-pattern labels propagated into grouped search rows, live in `tool-activity/classification.ts` and are re-exported through `toolRenderUtils.ts`.
`devryan_browser` is a dedicated passive turn-level activity: aggregation keeps canonical tool parts intact while presenting all browser commands across narration and assistant siblings as one non-expandable row anchored to the first call in both Live and Sorted modes.
Expandable fallback selection lives in `toolExpandedFallback.ts`; provider-native task result/failure projection lives in `taskToolUtils.ts` and is rendered by `TaskToolSummary.tsx`. `taskToolUtils.ts` also routes bounded linked-child message polls through the shared sync materializer so delayed HTTP snapshots cannot replace newer terminal SSE state or drop older cached child activity.
`terminalTranscript.ts` incrementally projects Bash output into a bounded visible terminal transcript. `ToolScrollableSection.tsx` owns paint-synchronous bottom following that releases as soon as the user scrolls upward, while its pure threshold policy lives in `toolScrollFollow.ts` so the component remains Fast Refresh-safe.
`ReasoningGroup.tsx` collapses adjacent provider-normalized reasoning parts to the latest non-empty line, keeps earlier export roots mounted behind an accessible disclosure, and animates only genuine part-ID changes. `../reasoningGrouping.ts` owns the pure Live/Sorted grouping scans.

## Flow
Message rows iterate parts and delegate rendering; part components format streaming updates safely.

## Integration
Used by chat/message components and backed by shared markdown/tool helpers.
