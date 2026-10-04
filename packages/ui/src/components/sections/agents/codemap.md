# packages/ui/src/components/sections/agents/

## Responsibility
Feature sections for the Settings experience (providers, projects, behavior, etc.).

## Design
Section-per-domain pattern with shared primitives for consistency.

Settings → Agents is one destination with no tab strip. `useAgentsSettingsEntries.ts`
owns its entries, selection and navigation, shared by `AgentsSidebar.tsx` and
the compact `AgentsSettingsPicker` (managed shell below `md`): a pinned General
group (Session Defaults, Behavior, Runtime), then collapsible Primary Agents and
Subagents with search and a Default badge on the session-default agent.
Session Defaults is the separate `sessions` settings page (own permission
boundary and deep link) shown beside this sidebar; Behavior and Runtime are
`useAgentsStore.selectedGlobalView` views of the `agents` page while no agent
is selected. The hook applies the effective `agents.hideGlobalBehaviorUi`
policy: when Behavior is hidden it is never selected or mounted, and a stale
Behavior selection falls back to the first visible primary or subagent. Runtime
is offered only to host editors (local admin or administrator); agent rows,
Behavior and Runtime require Agents read access.

`SessionDefaultsPage.tsx` renders New Sessions (default agent, start in Plan
Mode, with Personal/Inherited reset for managed accounts), a read-only Agent
Models summary for Agents readers whose rows open that agent's editor, and the
session Cleanup rows from `openchamber/SessionRetentionSettings.tsx`.

`AgentsPage.tsx` separates host-agent editing from managed-developer personal
defaults. A developer with Host Settings plus Agents Read/Edit may change only
Model and Thinking for single-model primary agents and subagents. Those saves
use the personal agent-default API, show Personal/Inherited provenance, and
never mutate host agent files. Council and every non-model field remain
host-managed.

`AgentRuntimePage.tsx` is the host-wide Runtime view: `AgentRuntimeSection`,
bundled OpenCode runtime status (`openchamber/OpenCodeCliSettings.tsx`), and local
Electron Agent Browser Control. `AgentRuntimeSection.tsx` is never rendered
inside one agent's editor: the agent-runtime
language-server switch (`/api/config/agent-runtime`) compares desired settings
against the server's last successfully applied managed launch snapshot. Unknown
and external application states are explicit. Serialized saves keep confirmed
values while pending; accepted restarts and configuration-apply transitions only
refresh server state. A known pending managed change exposes Restart Runtime
where supported. Host admins edit; other principals read the desired values.

## Flow
Settings navigation selects a section; section reads/writes config through hooks/APIs.

## Integration
Integrated with views, lib adapters, and settings/auth stores. Personal model
selections are persisted in the principal's managed settings overrides and are
edited only on the agent's page; Session Defaults summarizes the effective
model per agent without a second editor.

Thinking controls include Default explicitly. Opening and saving a model-only
agent setting preserves provider default; an advertised explicit effort remains
unchanged. Personal rows without a variant mean provider default, while removing
the personal row restores inheritance from the host.
