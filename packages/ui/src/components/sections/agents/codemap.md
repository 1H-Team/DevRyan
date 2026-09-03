# packages/ui/src/components/sections/agents/

## Responsibility
Feature sections for the Settings experience (providers, projects, behavior, etc.).

## Design
Section-per-domain pattern with shared primitives for consistency.

`AgentsSidebar.tsx` applies the effective `agents.hideGlobalBehaviorUi` policy
before rendering navigation. When Behavior is hidden it is never selected or
mounted; a stale Behavior selection falls back to the first visible primary or
subagent.

`AgentsPage.tsx` separates host-agent editing from managed-developer personal
defaults. A developer with Host Settings plus Agents Read/Edit may change only
Model and Thinking for single-model primary agents and subagents. Those saves
use the personal agent-default API, show Personal/Inherited provenance, and
never mutate host agent files. Council and every non-model field remain
host-managed.

`SubagentLimitsSection.tsx` and `AgentRuntimeSection.tsx` are host-wide policy
sections rendered inside Global Agent Behavior, never inside one agent's
editor: the sub-agent concurrency cap and memory-pressure pause, and the
agent-runtime language-server switch (`/api/config/agent-runtime`, applied on
the next managed runtime restart; a changed value shows a restart note and,
where the host exposes `restartOpenCode`, a Restart Runtime button). Host
admins edit; other principals read the effective values.

## Flow
Settings navigation selects a section; section reads/writes config through hooks/APIs.

## Integration
Integrated with views, lib adapters, and settings/auth stores. Personal model
selections are persisted in the principal's managed settings overrides and are
also surfaced in the Sessions settings editor under the same authorization
gate.
