# packages/ui/src/components/chat/message/parts/tool-activity/

## Responsibility
Renders tool-execution activity rows within chat message parts.

## Design

`targets.ts` uses the shared tool diff preview budget before deriving patch counts or file summaries. Oversized raw sources retain authoritative metadata counts and their complete download source; they do not acquire partial inferred totals.
Part-specific subcomponents isolate tool status formatting and incremental updates.

## Flow
Message-part data enters from chat store; components map tool events to badges/log snippets.

## Integration
Mounted by chat/message/parts and fed by sync/store event pipelines.
