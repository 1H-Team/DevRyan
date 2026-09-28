import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Agent } from '@opencode-ai/sdk/v2';
import { canAccessSettingsPage, isGlobalAgentBehaviorUiHidden, useAuthPrincipal, type AuthPrincipal } from '@/lib/authSession';
import { formatAgentDisplayName } from '@/lib/agentDisplay';
import { resolveDefaultAgentName, resolveSelectableAgentOptions } from '@/lib/agentSelection';
import { resolveSettingsSlug } from '@/lib/settings/metadata';
import { filterVisibleSettingsAgents, useAgentsStore, type AgentsGlobalView } from '@/stores/useAgentsStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';

/** Host-wide agent runtime (language server, OpenCode binary, browser control) is host-editor only. */
export const canViewAgentRuntime = (principal: AuthPrincipal): boolean => (
  principal.scope === 'local-admin' || principal.role === 'admin'
);

/** The global view actually shown, after dropping views the principal cannot open. */
export const resolveAgentsGlobalView = (view: AgentsGlobalView, principal: AuthPrincipal): AgentsGlobalView => (
  view === 'runtime' && canViewAgentRuntime(principal) ? 'runtime' : 'behavior'
);

/** The agent new sessions start with, resolved exactly like the Session Defaults picker. */
export const useSessionDefaultAgentName = (): string => {
  const agents = useAgentsStore((state) => state.agents);
  const configAgents = useConfigStore((state) => state.agents);
  const settingsDefaultAgent = useConfigStore((state) => state.settingsDefaultAgent);
  return React.useMemo(
    () => resolveDefaultAgentName(settingsDefaultAgent, resolveSelectableAgentOptions(configAgents, agents)),
    [agents, configAgents, settingsDefaultAgent],
  );
};

export type AgentsSettingsGeneralEntry = {
  kind: 'session-defaults' | AgentsGlobalView;
  id: string;
  selected: boolean;
};

export type AgentsSettingsAgentEntry = {
  kind: 'agent';
  id: string;
  agent: Agent;
  label: string;
  isSessionDefault: boolean;
  selected: boolean;
};

export type AgentsSettingsEntry = AgentsSettingsGeneralEntry | AgentsSettingsAgentEntry;

const PRIMARY_AGENT_ORDER = new Map([
  ['builder', 0],
  ['council', 1],
  ['orchestrator', 2],
]);

const comparePrimaryAgents = (a: Agent, b: Agent) => {
  const aRank = PRIMARY_AGENT_ORDER.get(a.name.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
  const bRank = PRIMARY_AGENT_ORDER.get(b.name.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
  if (aRank !== bRank) return aRank - bRank;
  return formatAgentDisplayName(a.name).localeCompare(formatAgentDisplayName(b.name));
};

const matchesQuery = (agent: Agent, query: string) => (
  !query
  || formatAgentDisplayName(agent.name).toLowerCase().includes(query)
  || agent.name.toLowerCase().includes(query)
  || (agent.description ?? '').toLowerCase().includes(query)
);

/**
 * Entries of the Agents settings sidebar: Session Defaults (its own `sessions`
 * page), the host-wide Behavior and Runtime views, then primary agents and
 * subagents. Shared by the sidebar and the compact managed picker so selection
 * and navigation stay identical.
 */
export const useAgentsSettingsEntries = (searchQuery = '') => {
  const principal = useAuthPrincipal();
  const settingsPage = useUIStore((state) => state.settingsPage);
  const { agents, selectedAgentName, selectedGlobalView, setSelectedAgent, setSelectedGlobalView } = useAgentsStore(
    useShallow((state) => ({
      agents: state.agents,
      selectedAgentName: state.selectedAgentName,
      selectedGlobalView: state.selectedGlobalView,
      setSelectedAgent: state.setSelectedAgent,
      setSelectedGlobalView: state.setSelectedGlobalView,
    })),
  );
  const sessionDefaultAgentName = useSessionDefaultAgentName();

  const canReadAgents = canAccessSettingsPage(principal, 'agents');
  const canReadSessions = canAccessSettingsPage(principal, 'sessions');
  const behaviorHidden = isGlobalAgentBehaviorUiHidden(principal);
  const runtimeVisible = canReadAgents && canViewAgentRuntime(principal);
  const activeSlug = resolveSettingsSlug(settingsPage);
  const onAgentsPage = activeSlug === 'agents';
  const globalView = resolveAgentsGlobalView(selectedGlobalView, principal);

  const visibleAgents = React.useMemo(
    () => (canReadAgents ? filterVisibleSettingsAgents(agents) : []),
    [agents, canReadAgents],
  );
  const orderedAgents = React.useMemo(() => {
    const primary = visibleAgents
      .filter((agent) => agent.mode === 'primary' || agent.mode === 'all')
      .sort(comparePrimaryAgents);
    const subagents = visibleAgents
      .filter((agent) => agent.mode === 'subagent')
      .sort((a, b) => formatAgentDisplayName(a.name).localeCompare(formatAgentDisplayName(b.name)));
    return { primary, subagents };
  }, [visibleAgents]);

  // Without the Behavior view, an empty selection has nothing to show.
  React.useEffect(() => {
    if (!behaviorHidden || selectedAgentName !== null) return;
    const fallback = orderedAgents.primary[0] ?? orderedAgents.subagents[0];
    if (fallback) setSelectedAgent(fallback.name);
  }, [behaviorHidden, orderedAgents, selectedAgentName, setSelectedAgent]);

  const general = React.useMemo<AgentsSettingsGeneralEntry[]>(() => {
    const entries: AgentsSettingsGeneralEntry[] = [];
    if (canReadSessions) {
      entries.push({ kind: 'session-defaults', id: 'session-defaults', selected: activeSlug === 'sessions' });
    }
    if (canReadAgents && !behaviorHidden) {
      entries.push({
        kind: 'behavior',
        id: 'behavior',
        selected: onAgentsPage && selectedAgentName === null && globalView === 'behavior',
      });
    }
    if (runtimeVisible) {
      entries.push({
        kind: 'runtime',
        id: 'runtime',
        selected: onAgentsPage && selectedAgentName === null && globalView === 'runtime',
      });
    }
    return entries;
  }, [activeSlug, behaviorHidden, canReadAgents, canReadSessions, globalView, onAgentsPage, runtimeVisible, selectedAgentName]);

  const query = searchQuery.trim().toLowerCase();
  const toAgentEntry = React.useCallback((agent: Agent): AgentsSettingsAgentEntry => ({
    kind: 'agent',
    id: `agent:${agent.name}`,
    agent,
    label: formatAgentDisplayName(agent.name),
    isSessionDefault: agent.name === sessionDefaultAgentName,
    selected: onAgentsPage && selectedAgentName === agent.name,
  }), [onAgentsPage, selectedAgentName, sessionDefaultAgentName]);

  const primaryAgents = React.useMemo(
    () => orderedAgents.primary.filter((agent) => matchesQuery(agent, query)).map(toAgentEntry),
    [orderedAgents.primary, query, toAgentEntry],
  );
  const subagents = React.useMemo(
    () => orderedAgents.subagents.filter((agent) => matchesQuery(agent, query)).map(toAgentEntry),
    [orderedAgents.subagents, query, toAgentEntry],
  );

  const select = React.useCallback((entry: AgentsSettingsEntry) => {
    const { settingsPage: currentPage, setSettingsPage } = useUIStore.getState();
    const targetSlug = entry.kind === 'session-defaults' ? 'sessions' : 'agents';
    if (entry.kind === 'agent') {
      setSelectedAgent(entry.agent.name);
    } else if (entry.kind !== 'session-defaults') {
      setSelectedGlobalView(entry.kind);
    }
    if (currentPage !== targetSlug) setSettingsPage(targetSlug);
  }, [setSelectedAgent, setSelectedGlobalView]);

  return {
    general,
    primaryAgents,
    subagents,
    totalAgents: visibleAgents.length,
    canReadAgents,
    isSearching: query.length > 0,
    select,
  };
};
