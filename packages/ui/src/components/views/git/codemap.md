# packages/ui/src/components/views/git/

## Responsibility
Git-focused view components for repository status, diffs, and related workflows.

## Design
View modules orchestrate smaller components and domain hooks for git operations.
`gitBranchVisibility.ts` applies managed-project branch grants before Source-view branch lists and branch actions receive their options; unresolved managed directories fail closed.
It resolves commit-reintegration targets separately from PR bases: direct writes exclude the current branch and ungranted defaults, while PR creation may still target a readable unassigned base such as `main`.
`PullRequestSection.tsx` exclusively owns PR presentation. It lands on the current branch workflow, links to an all-state paginated repository-network browser, and renders non-current selections read-only. Terminal PRs remain linked while a persisted next-cycle draft is composed for the same long-lived branch, and low-frequency terminal discovery can replace them with a newly opened PR.

## Flow
Route/view entry reads git state via hooks and renders panels/actions.
`GitView.tsx` passes authoritative Git status into the changes, history, synchronization, conflict, and commit workflows.

## Integration
Depends on lib/git, stores, and shared UI primitives.
