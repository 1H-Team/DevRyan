# packages/ui/src/components/sections/mcp/

## Responsibility
MCP Servers configuration and Bot MCP assignment settings.

## Design
MCP Servers is the third tab of the Plugins hub in Settings → Connections. The
sidebar uses the shared settings sidebar header/layout/group primitives with one
`McpServerListItem` row component for project and user servers; the detail page
uses `SettingsDetailHeader` (transport icon, status `SettingsBadge`, runtime
actions). Bots have no MCP assignment surface.

## Flow
Settings navigation selects the stable `mcp` slug. Coding Agent edits use the
MCP config store; Bot assignment, credential import/rotation, and update checks
use optimistic Bot APIs and never expose secret values after submission.

## Integration
Integrated with views, lib adapters, and settings/auth stores.
