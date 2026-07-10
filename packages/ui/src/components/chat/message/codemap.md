# packages/ui/src/components/chat/message/

## Responsibility
Implements chat message row rendering, grouping, and metadata presentation.

## Design
Memoized row components with render-relevant props to reduce streaming re-renders. Assistant error classification and retryable error-banner actions remain isolated from part rendering.

## Flow
Session messages flow from stores into rows, then into part renderers for granular output.

## Integration
Consumes chat hooks/store selectors and composes parts/components utilities.
