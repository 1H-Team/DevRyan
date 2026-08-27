# packages/ui/src/components/sections/skills/

## Responsibility
Settings sections for skill management and related configuration controls.

## Design
Section components share common settings primitives and domain-specific forms.
`SettingsView` places the shared Coding Agents/Bots tablist above the split
pane. Coding Agents keeps installed/catalog behavior; Bots reuses the Bot list
and revision-bound `BotCapabilityAssignments` skill panel.

## Flow
Settings view mounts this section; audience changes retain independent feature
selection and return mobile navigation to the list. Coding Agent edits update
the skills store; Bot mutations use optimistic Bot revision APIs.

## Integration
Connected to skills catalog components, lib/api, and shared section wrappers.
