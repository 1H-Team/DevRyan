# packages/ui/src/components/session/

## Responsibility
Session-oriented UI components outside the chat stream itself.

## Design
Feature components encapsulate session metadata, controls, and supporting panes.
`NewWorktreeDialog.tsx` remains open through durable bootstrap progress,
reconnects active receipts after reload, and exposes explicit Retry/Remove for
failed or needs-attention setup. Its idempotency key is bound to a normalized
request signature, so changing branch/setup inputs after a terminal attempt
starts a new operation while an unchanged retry reuses the prior key.
Sidebar utilities keep sorting, grouping, visible draft selection, and hint-first
session directory routing logic testable outside React rendering. Every role
discovers real Git worktrees; managed non-admin results are filtered by the
authoritative branch-visibility projection before entering shared UI state.
When branch creation is disabled by effective policy, the worktree dialog
offers only existing assigned branches and indirect issue/todo creation actions
do not expose new-branch worktree choices.
`SessionSidebar.tsx` also owns the mutually exclusive audience panels. The
session-only audience store defaults cold starts to Coding Agents and preserves
each audience's authoritative selection when switching; only Coding Agents
mounts project/session/draft/search/multi-run/scheduled-task controls.

## Flow
Session state enters via selectors/hooks; actions trigger archive/delete/switch workflows.

## Integration
Used by views/layout and connected to session stores plus API helpers.
