# packages/ui/src/components/session/

## Responsibility
Session-oriented UI components outside the chat stream itself.

## Design
Feature components encapsulate session metadata, controls, and supporting panes.
`NewWorktreeDialog.tsx` remains open through durable bootstrap progress,
reconnects active receipts after reload, and exposes explicit Retry/Remove for
failed or needs-attention setup.
Sidebar utilities keep sorting, grouping, visible draft selection, and hint-first
session directory routing logic testable outside React rendering.

## Flow
Session state enters via selectors/hooks; actions trigger archive/delete/switch workflows.

## Integration
Used by views/layout and connected to session stores plus API helpers.
