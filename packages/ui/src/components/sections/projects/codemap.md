# packages/ui/src/components/sections/projects/

## Responsibility
Feature sections for the Settings experience (providers, projects, behavior, etc.).

## Design
Section-per-domain pattern with shared primitives for consistency.
`TurnEvidenceSettingsSection.tsx` owns the default-off per-project checkpoint
toggle and confirmed deletion of retained evidence for the primary repository
and its worktrees.

## Flow
Settings navigation selects a section; section reads/writes config through hooks/APIs.

## Integration
Integrated with views, lib adapters, and settings/auth stores.
