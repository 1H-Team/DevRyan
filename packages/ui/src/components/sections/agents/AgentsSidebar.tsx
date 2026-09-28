import React from 'react';
import {
  RiAiAgentLine,
  RiBrainLine,
  RiChatHistoryLine,
  RiCloseLine,
  RiCpuLine,
  RiRobot2Line,
  RiSearchLine,
} from '@remixicon/react';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { getAgentIconColor } from '@/lib/agentColors';
import { useAgentsStore } from '@/stores/useAgentsStore';
import {
  SettingsBadge,
  SettingsEmptyState,
  SettingsSidebarHeader,
  SettingsSidebarItem,
  SettingsSidebarLayout,
  SidebarGroup,
} from '@/components/sections/shared';
import {
  useAgentsSettingsEntries,
  type AgentsSettingsAgentEntry,
  type AgentsSettingsEntry,
  type AgentsSettingsGeneralEntry,
} from './useAgentsSettingsEntries';

interface AgentsSidebarProps {
  onItemSelect?: () => void;
}

const AGENTS_GENERAL_ENTRY_COPY: Record<AgentsSettingsGeneralEntry['kind'], {
  icon: React.ComponentType<{ className?: string }>;
  titleKey: I18nKey;
  descriptionKey: I18nKey;
}> = {
  'session-defaults': {
    icon: RiChatHistoryLine,
    titleKey: 'settings.agents.sidebar.sessionDefaults',
    descriptionKey: 'settings.agents.sidebar.sessionDefaultsDescription',
  },
  behavior: {
    icon: RiBrainLine,
    titleKey: 'settings.agents.sidebar.behavior',
    descriptionKey: 'settings.agents.sidebar.behaviorDescription',
  },
  runtime: {
    icon: RiCpuLine,
    titleKey: 'settings.agents.sidebar.runtime',
    descriptionKey: 'settings.agents.sidebar.runtimeDescription',
  },
};

export const AgentsSidebar: React.FC<AgentsSidebarProps> = ({ onItemSelect }) => {
  const { t } = useI18n();
  const loadAgents = useAgentsStore((state) => state.loadAgents);
  const [searchQuery, setSearchQuery] = React.useState('');
  const {
    general,
    primaryAgents,
    subagents,
    totalAgents,
    canReadAgents,
    isSearching,
    select,
  } = useAgentsSettingsEntries(searchQuery);

  React.useEffect(() => {
    if (canReadAgents) void loadAgents();
  }, [canReadAgents, loadAgents]);

  const renderGeneral = (entry: AgentsSettingsGeneralEntry) => {
    const copy = AGENTS_GENERAL_ENTRY_COPY[entry.kind];
    const Icon = copy.icon;
    return (
      <SettingsSidebarItem
        key={entry.id}
        title={t(copy.titleKey)}
        metadata={<span className="pl-5">{t(copy.descriptionKey)}</span>}
        selected={entry.selected}
        onSelect={() => {
          select(entry);
          onItemSelect?.();
        }}
        icon={<Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        className="py-1"
      />
    );
  };

  const renderAgent = (entry: AgentsSettingsAgentEntry) => (
    <SettingsSidebarItem
      key={entry.id}
      title={entry.label}
      metadata={entry.agent.description ? <span className="pl-5">{entry.agent.description}</span> : undefined}
      selected={entry.selected}
      onSelect={() => {
        select(entry);
        onItemSelect?.();
      }}
      icon={(
        <RiAiAgentLine
          className="h-3.5 w-3.5 shrink-0"
          style={{ color: `var(${getAgentIconColor(entry.agent.name).var})` }}
        />
      )}
      trailing={entry.isSessionDefault ? (
        <SettingsBadge tone="accent" className="px-1.5 py-0" title={t('settings.agents.sidebar.badge.defaultTitle')}>
          {t('settings.agents.sidebar.badge.default')}
        </SettingsBadge>
      ) : null}
      className="py-1"
    />
  );

  const matchCount = primaryAgents.length + subagents.length;

  return (
    <SettingsSidebarLayout
      variant="background"
      header={(
        <SettingsSidebarHeader
          title={t('settings.agents.sidebar.title')}
          countLabel={canReadAgents ? (isSearching
            ? t('settings.agents.sidebar.search.matchCount', { count: matchCount, total: totalAgents })
            : t('settings.agents.sidebar.total', { count: totalAgents })) : undefined}
        >
          {canReadAgents && totalAgents > 0 ? (
            <div className="relative">
              <RiSearchLine className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={t('settings.agents.sidebar.search.placeholder')}
                aria-label={t('settings.agents.sidebar.search.placeholder')}
                className="h-7 pl-7 pr-7 [&::-webkit-search-cancel-button]:appearance-none"
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && searchQuery) {
                    event.preventDefault();
                    event.stopPropagation();
                    setSearchQuery('');
                  }
                }}
              />
              {isSearching ? (
                <button
                  type="button"
                  aria-label={t('settings.agents.sidebar.search.clearAria')}
                  onClick={() => setSearchQuery('')}
                  className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                >
                  <RiCloseLine className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          ) : null}
        </SettingsSidebarHeader>
      )}
    >
      {!isSearching && general.length > 0 ? (
        <div className="space-y-0.5 pb-2">
          <div className="px-1.5 py-1 typography-micro font-semibold uppercase tracking-[0.08em] text-muted-foreground/80">
            {t('settings.agents.sidebar.section.general')}
          </div>
          {general.map(renderGeneral)}
        </div>
      ) : null}

      {!canReadAgents ? null : totalAgents === 0 ? (
        <SettingsEmptyState
          icon={RiRobot2Line}
          title={t('settings.agents.sidebar.empty.title')}
          description={t('settings.agents.sidebar.empty.description')}
        />
      ) : isSearching && matchCount === 0 ? (
        <SettingsEmptyState
          icon={RiSearchLine}
          title={t('settings.agents.sidebar.search.empty.title')}
          description={t('settings.agents.sidebar.search.empty.description')}
        />
      ) : (
        <>
          {primaryAgents.length > 0 ? (
            <SidebarGroup
              label={t('settings.agents.sidebar.section.builtIn')}
              count={primaryAgents.length}
              storageKey="settings-agents"
            >
              {primaryAgents.map(renderAgent)}
            </SidebarGroup>
          ) : null}
          {subagents.length > 0 ? (
            <SidebarGroup
              label={t('settings.agents.sidebar.section.subagents')}
              count={subagents.length}
              storageKey="settings-agents"
            >
              {subagents.map(renderAgent)}
            </SidebarGroup>
          ) : null}
        </>
      )}
    </SettingsSidebarLayout>
  );
};

/**
 * Compact entry picker for layouts that hide the sidebar on small screens
 * (the managed settings frame). Same entries and navigation as the sidebar.
 */
export const AgentsSettingsPicker: React.FC = () => {
  const { t } = useI18n();
  const { general, primaryAgents, subagents, select } = useAgentsSettingsEntries();
  const entries: AgentsSettingsEntry[] = [...general, ...primaryAgents, ...subagents];
  const selected = entries.find((entry) => entry.selected);
  if (entries.length < 2) return null;

  const labelFor = (entry: AgentsSettingsEntry) => (
    entry.kind === 'agent' ? entry.label : t(AGENTS_GENERAL_ENTRY_COPY[entry.kind].titleKey)
  );

  return (
    <div className="border-b border-border px-3 py-2">
      <Select
        value={selected?.id ?? ''}
        onValueChange={(id: string) => {
          const entry = entries.find((candidate) => candidate.id === id);
          if (entry) select(entry);
        }}
      >
        <SelectTrigger className="w-full" aria-label={t('settings.agents.sidebar.pickerAria')}>
          <SelectValue placeholder={t('settings.agents.sidebar.title')}>
            {selected ? labelFor(selected) : null}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {general.length > 0 ? (
            <SelectGroup>
              <SelectLabel>{t('settings.agents.sidebar.section.general')}</SelectLabel>
              {general.map((entry) => <SelectItem key={entry.id} value={entry.id}>{labelFor(entry)}</SelectItem>)}
            </SelectGroup>
          ) : null}
          {primaryAgents.length > 0 ? (
            <SelectGroup>
              <SelectLabel>{t('settings.agents.sidebar.section.builtIn')}</SelectLabel>
              {primaryAgents.map((entry) => <SelectItem key={entry.id} value={entry.id}>{entry.label}</SelectItem>)}
            </SelectGroup>
          ) : null}
          {subagents.length > 0 ? (
            <SelectGroup>
              <SelectLabel>{t('settings.agents.sidebar.section.subagents')}</SelectLabel>
              {subagents.map((entry) => <SelectItem key={entry.id} value={entry.id}>{entry.label}</SelectItem>)}
            </SelectGroup>
          ) : null}
        </SelectContent>
      </Select>
    </div>
  );
};
