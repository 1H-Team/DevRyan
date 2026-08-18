import React from 'react';
import { RiAiAgentLine, RiRobot2Line } from '@remixicon/react';
import { useShallow } from 'zustand/react/shallow';
import type { Agent } from '@opencode-ai/sdk/v2';
import { useAgentsStore, filterVisibleSettingsAgents } from '@/stores/useAgentsStore';
import { cn } from '@/lib/utils';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useI18n } from '@/lib/i18n';
import { formatAgentDisplayName } from '@/lib/agentDisplay';
import { getAgentIconColor } from '@/lib/agentColors';

interface AgentsSidebarProps {
  onItemSelect?: () => void;
}

export const AgentsSidebar: React.FC<AgentsSidebarProps> = ({ onItemSelect }) => {
  const { t } = useI18n();
  const {
    selectedAgentName,
    agents,
    setSelectedAgent,
    loadAgents,
  } = useAgentsStore(useShallow((s) => ({
    selectedAgentName: s.selectedAgentName,
    agents: s.agents,
    setSelectedAgent: s.setSelectedAgent,
    loadAgents: s.loadAgents,
  })));

  React.useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  const visibleAgents = filterVisibleSettingsAgents(agents);
  const isPrimaryAgent = (agent: Agent) => agent.mode === 'primary' || agent.mode === 'all';
  const primaryAgentOrder = new Map([
    ['builder', 0],
    ['council', 1],
    ['orchestrator', 2],
  ]);
  const comparePrimaryAgents = (a: Agent, b: Agent) => {
    const aRank = primaryAgentOrder.get(a.name.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    const bRank = primaryAgentOrder.get(b.name.toLowerCase()) ?? Number.MAX_SAFE_INTEGER;
    if (aRank !== bRank) return aRank - bRank;
    return formatAgentDisplayName(a.name).localeCompare(formatAgentDisplayName(b.name));
  };

  const primaryAgents = visibleAgents
    .filter(isPrimaryAgent)
    .sort(comparePrimaryAgents);
  const subagents = visibleAgents
    .filter((agent) => agent.mode === 'subagent')
    .sort((a, b) => formatAgentDisplayName(a.name).localeCompare(formatAgentDisplayName(b.name)));

  const renderAgent = (agent: Agent, options: { spacious?: boolean } = {}) => (
    <AgentListItem
      key={agent.name}
      agent={agent}
      isSelected={selectedAgentName === agent.name}
      onSelect={() => {
        setSelectedAgent(agent.name);
        onItemSelect?.();
      }}
      spacious={options.spacious}
    />
  );

  const renderBehavior = () => (
    <div
      className={cn(
        'group relative flex items-center rounded-md px-1.5 py-2.5 transition-all duration-200 select-none',
        selectedAgentName === null ? 'bg-interactive-selection' : 'hover:bg-interactive-hover',
      )}
    >
      <button
        onClick={() => {
          setSelectedAgent(null);
          onItemSelect?.();
        }}
        className="flex min-w-0 flex-1 flex-col gap-0 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        tabIndex={0}
      >
        <div className="flex items-center gap-1.5">
          <span className="typography-ui-label font-normal truncate text-foreground">
            {t('settings.agents.sidebar.behavior')}
          </span>
        </div>
      </button>
    </div>
  );

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="border-b px-3 pt-4 pb-3">
        <h2 className="text-base font-semibold text-foreground mb-3">{t('settings.agents.sidebar.title')}</h2>
        <div className="flex items-center gap-2">
          <span className="typography-meta text-muted-foreground">{t('settings.agents.sidebar.total', { count: visibleAgents.length })}</span>
        </div>
      </div>

      <ScrollableOverlay outerClassName="flex-1 min-h-0" className="space-y-1 px-3 py-2 overflow-x-hidden">
        {renderBehavior()}

        {visibleAgents.length === 0 ? (
          <div className="py-12 px-4 text-center text-muted-foreground">
            <RiRobot2Line className="mx-auto mb-3 h-10 w-10 opacity-50" />
            <p className="typography-ui-label font-medium">{t('settings.agents.sidebar.empty.title')}</p>
            <p className="typography-meta mt-1 opacity-75">{t('settings.agents.sidebar.empty.description')}</p>
          </div>
        ) : (
          <>
            {primaryAgents.length > 0 && (
              <>
                <div className="px-2 pb-1.5 pt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('settings.agents.sidebar.section.builtIn')}
                </div>
                {primaryAgents.map((agent) => renderAgent(agent, { spacious: true }))}
              </>
            )}

            {subagents.length > 0 && (
              <>
                <div className="px-2 pb-1.5 pt-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('settings.agents.sidebar.section.subagents')}
                </div>
                {subagents.map((agent) => renderAgent(agent))}
              </>
            )}
          </>
        )}
      </ScrollableOverlay>
    </div>
  );
};

interface AgentListItemProps {
  agent: Agent;
  isSelected: boolean;
  onSelect: () => void;
  spacious?: boolean;
}

const AgentListItem: React.FC<AgentListItemProps> = ({
  agent,
  isSelected,
  onSelect,
  spacious = false,
}) => {
  return (
    <div
      className={cn(
        'group relative flex items-center rounded-md px-1.5 py-1 transition-all duration-200 select-none',
        spacious && 'py-2.5',
        isSelected ? 'bg-interactive-selection' : 'hover:bg-interactive-hover',
      )}
    >
      <button
        onClick={onSelect}
        className="flex min-w-0 flex-1 flex-col gap-0 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        tabIndex={0}
      >
        <div className="flex items-center gap-1.5">
          <RiAiAgentLine
            className="h-3.5 w-3.5 flex-shrink-0"
            style={{ color: `var(${getAgentIconColor(agent.name).var})` }}
          />
          <span className="typography-ui-label font-normal truncate text-foreground">
            {formatAgentDisplayName(agent.name)}
          </span>
        </div>

        {agent.description && (
          <div className="typography-micro text-muted-foreground/60 truncate leading-tight pl-[1.25rem]">
            {agent.description}
          </div>
        )}
      </button>
    </div>
  );
};
