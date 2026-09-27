# packages/ui/src/components/sections/skills/

## Responsibility
Settings sections for skill management and related configuration controls.

## Design
Section components share common settings primitives and domain-specific forms.
Skills is the second tab of the Plugins hub in Settings → Connections; the
Skills Catalog opens inside that tab. The sidebar uses the shared settings
sidebar header/layout and `SidebarGroup` for locations, keeping
`SkillFolderGroup` for nested folders; the detail page uses
`SettingsDetailHeader`. Bot SOP Skills are chosen from the Bot Resources tab.

## Flow
Settings view mounts this section; audience changes retain independent feature
selection and return mobile navigation to the list. Coding Agent edits update
the skills store; Bot mutations use optimistic Bot revision APIs.

## Integration
Connected to skills catalog components, lib/api, and shared section wrappers.
