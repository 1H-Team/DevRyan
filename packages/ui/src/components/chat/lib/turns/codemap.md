# packages/ui/src/components/chat/lib/turns/

## Responsibility
Contains helpers for turn segmentation and turn-level chat presentation logic.

## Design
Turn-aware transformation utilities normalize raw message sequences into UI-friendly groups. `projectPlanTurnTraceIndex.ts` derives stable per-session plan versions and source/parent/actionability indexes from canonical turn history; unchanged indexes retain reference identity during streaming.

## Flow
Incoming message arrays are grouped/annotated, plan-mode turns are indexed in canonical order, then the combined projection is consumed by chat rendering components.

## Integration
Integrated with chat store selectors and message row components.
