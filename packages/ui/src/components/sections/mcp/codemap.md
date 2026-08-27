# packages/ui/src/components/sections/mcp/

## Responsibility
MCP Servers configuration and Bot MCP assignment settings.

## Design
`SettingsView` places the shared Coding Agents/Bots tablist above the split
pane. Coding Agents keeps the existing MCP server editor; Bots reuses the Bot
list and revision-bound `BotCapabilityAssignments` MCP panel.

## Flow
Settings navigation selects the stable `mcp` slug. Coding Agent edits use the
MCP config store; Bot assignment, credential import/rotation, and update checks
use optimistic Bot APIs and never expose secret values after submission.

## Integration
Integrated with views, lib adapters, and settings/auth stores.
