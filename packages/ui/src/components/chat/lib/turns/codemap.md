# packages/ui/src/components/chat/lib/turns/

## Responsibility
Contains helpers for turn segmentation and turn-level chat presentation logic.

## Design
Turn-aware transformation utilities normalize raw message sequences into UI-friendly groups. `projectPlanTurnTraceIndex.ts` derives stable per-session plan versions and source/parent/actionability indexes from canonical turn history via the shared `@/lib/messages/planRevisions` projection: compaction-only and fully synthetic continuation turns fold into their originating plan revision, each revision has exactly one source message, sibling roles (before/source/after) and suppressed post-source turns are indexed for rendering, and actionability requires the revision to be settled. Unchanged indexes retain reference identity during streaming.

## Flow
Incoming message arrays are grouped/annotated, plan-mode turns are indexed in canonical order, then the combined projection is consumed by chat rendering components.

## Integration
Integrated with chat store selectors and message row components.
