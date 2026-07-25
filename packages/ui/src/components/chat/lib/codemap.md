# packages/ui/src/components/chat/lib/

## Responsibility
Utility layer for chat-specific data shaping and rendering helpers.

## Design
Pure helper modules isolate formatting/grouping logic from React components.
- `selectionClipboard.ts` normalizes native selection-copy text from chat message DOM selections.
- `chatFlowTrace.ts` defines the versioned, JSON-safe acceptance artifact used to correlate runtime/session/turn/message/queue/plan/abort evidence without persisting product telemetry.
- `modelPickerScroll.ts` captures and safely restores composer model-picker scroll offsets across favorite-list reflows.

## Flow
Chat components pass message/session state through helpers before rendering.

## Integration
Used by chat hooks, message rows, and composer/scroll behaviors.
