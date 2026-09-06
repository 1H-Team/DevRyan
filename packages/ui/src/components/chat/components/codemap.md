# packages/ui/src/components/chat/components/

## Responsibility
Composable subcomponents used by core chat containers and message UI.

## Design
Breaks large chat screens into memo-friendly presentational units.
`TurnItem.tsx` marks the normal-flow turn with its exact user-message ID so viewport restoration can measure it independently of the sticky user header.

## Flow
Containers pass streaming/session state down to focused UI widgets.

## Integration
Integrated with chat hooks, message renderers, and shared primitives.
