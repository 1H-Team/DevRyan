# packages/ui/src/components/chat/message/parts/

## Responsibility
Contains renderers for individual chat message part types (text, tool, attachments, etc.).

## Design
Part-dispatch pattern chooses a specialized renderer per part type.
Tool diff parsing lives in `toolPartDiffEntries.ts` so `ToolPart.tsx` remains a React-only component module for fast refresh.
Expandable fallback selection lives in `toolExpandedFallback.ts`; provider-native task result/failure projection lives in `taskToolUtils.ts` and is rendered by `TaskToolSummary.tsx`.

## Flow
Message rows iterate parts and delegate rendering; part components format streaming updates safely.

## Integration
Used by chat/message components and backed by shared markdown/tool helpers.
