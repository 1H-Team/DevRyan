import { getModelVariantControlState, getModelVariantDisplayState, resolveModelVariantSelection } from '@/lib/providers/variantControls';
import { ThinkingSlider } from './ThinkingSlider';
import { getChatThinkingState, resolveChatThinkingVariant } from '@/lib/providers/chatThinking';
import { getCursorAcpVariantState, resolveCursorAcpVariantSelection } from '@/lib/providers/cursorThinking';
import React from 'react';
import { RiCheckLine, RiFlashlightFill, RiSearchLine } from '@remixicon/react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useI18n } from '@/lib/i18n';
import { getExecutionProviderId, getModelDisplayName } from '@/lib/providers/modelIdentity';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import type { ProviderRecoverySelection } from '@/stores/useProviderRecoveryStore';

import {
  getControlledModelOptions,
  findControlledModelProvider,
  type ControlledModelOption,
  type ControlledModelPickerProvider,
} from './controlledModelPickerOptions';
import { formatEffortLabel } from './mobileControlsUtils';
import { LegacyModelsHeader, LegacyModelsRow, ModelPickerRail } from './ModelPickerParts';
import {
  buildModelPickerRefKey,
  buildModelPickerTabs,
  resolveDefaultModelPickerTabId,
  resolveModelPickerView,
  type ModelPickerRow,
} from './lib/modelPickerTabs';

export type { ControlledModelPickerProvider } from './controlledModelPickerOptions';

export function ControlledModelPicker({
  providers,
  value,
  onChange,
  disabled = false,
  align = 'start',
}: {
  providers: ControlledModelPickerProvider[];
  value: ProviderRecoverySelection;
  onChange(selection: ProviderRecoverySelection): void;
  disabled?: boolean;
  align?: 'start' | 'end';
}) {
  const { t } = useI18n();
  const hiddenModels = useUIStore((state) => state.hiddenModels);
  const favoriteModels = useUIStore((state) => state.favoriteModels);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [tabId, setTabId] = React.useState<string | null>(null);
  const [legacyOpen, setLegacyOpen] = React.useState(false);
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const options = React.useMemo(
    () => getControlledModelOptions(providers, hiddenModels),
    [hiddenModels, providers],
  );
  const nativeProvider = findControlledModelProvider(providers, value.providerId, value.modelId);
  const displayModelId = getModelVariantDisplayState(nativeProvider, value.modelId, value.variant)?.displayModelId ?? value.modelId;
  const selected = options.find((option) => (
    option.providerId === value.providerId && option.modelId === displayModelId
  ));
  // Thinking for the selected model lives in this picker: label in the trigger, slider under the list.
  const { levels, selected: activeLevel } = getChatThinkingState(nativeProvider, value.modelId, value.variant);
  const normalizedVariant = resolveChatThinkingVariant(nativeProvider, value.modelId, value.variant);
  const cursorThinking = getCursorAcpVariantState(nativeProvider, value.modelId, normalizedVariant);
  const fastState = cursorThinking ?? getModelVariantControlState(nativeProvider, value.modelId, normalizedVariant);
  const hasThinking = levels.length > 0 || Boolean(fastState?.canToggleFast);
  const applyThinking = (updates: { effort?: string; fastEnabled?: boolean }) => {
    const next = cursorThinking
      ? resolveCursorAcpVariantSelection(nativeProvider, value.modelId, normalizedVariant, updates)
      : resolveModelVariantSelection(nativeProvider, value.modelId, normalizedVariant, { variant: updates.effort, fastEnabled: updates.fastEnabled });
    onChange({ ...value, modelId: next.modelId, variant: next.variant ?? null });
  };
  // Same rail tabs (favorites + providers, legacy split) as the composer picker, limited to this picker's providers.
  const optionByKey = React.useMemo(
    () => new Map(options.map((option) => [buildModelPickerRefKey(option.providerId, option.modelId), option])),
    [options],
  );
  const tabs = React.useMemo(() => {
    const groups = new Map<string, { id: string; name: string; models: ControlledModelOption['model'][] }>();
    for (const option of options) {
      const group = groups.get(option.provider.id) ?? { id: option.provider.id, name: option.providerName, models: [] };
      group.models.push(option.model);
      groups.set(option.provider.id, group);
    }
    const favorites = favoriteModels.flatMap(({ providerID, modelID }) => {
      const option = optionByKey.get(buildModelPickerRefKey(providerID, modelID));
      return option ? [{ model: option.model, providerID, modelID }] : [];
    });
    return buildModelPickerTabs({
      providers: [...groups.values()],
      favorites,
      now: Date.now(),
      favoritesLabel: t('chat.modelControls.favorites'),
      getExecutionProviderId,
      getProviderName: (providerId) => options.find((option) => option.providerId === providerId)?.providerName ?? providerId,
      isCurrentModel: (providerId, modelId) => providerId === value.providerId && modelId === displayModelId,
    });
  }, [displayModelId, favoriteModels, optionByKey, options, t, value.providerId]);
  const view = resolveModelPickerView({
    tabs,
    activeTabId: tabId ?? resolveDefaultModelPickerTabId(tabs, value.providerId, displayModelId),
    legacyOpen,
    query,
    matches: (candidate, search) => candidate.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
    getModelLabel: getModelDisplayName,
  });
  const rows: ModelPickerRow<ControlledModelOption['model']>[] = view?.rows ?? [];
  const showProviderLogo = view?.mode === 'search' || view?.tab.kind === 'favorites';

  const selectTab = (nextTabId: string) => {
    setTabId(nextTabId);
    setLegacyOpen(false);
    setQuery('');
    searchInputRef.current?.focus();
  };

  const openProvidersSettings = () => {
    setSettingsPage('providers');
    setSettingsDialogOpen(true);
    setOpen(false);
  };

  const choose = (option: ControlledModelOption) => {
    onChange({
      providerId: option.providerId,
      modelId: option.modelId,
      variant: resolveChatThinkingVariant(
        findControlledModelProvider(providers, option.providerId, option.modelId),
        option.modelId,
        option.providerId === value.providerId && option.modelId === value.modelId
          ? value.variant ?? undefined
          : undefined,
      ) ?? null,
    });
  };

  return (
    <DropdownMenu open={open} onOpenChange={(next) => {
      setOpen(next);
      if (!next) {
        setQuery('');
        setTabId(null);
        setLegacyOpen(false);
      }
    }}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="model-controls__model-trigger flex h-8 min-w-0 items-center gap-1.5 border-0 bg-transparent p-0 text-left typography-meta font-medium text-foreground hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={t('chat.modelControls.model')}
        >
          {value.providerId ? <ProviderLogo providerId={selected?.providerId ?? value.providerId} className="h-[17.3px] w-[17.3px] shrink-0" /> : null}
          <span className={cn('max-w-[260px] truncate', !value.modelId && 'text-muted-foreground')}>{selected?.modelName ?? (value.modelId || t('chat.modelControls.selectModel'))}</span>
          {hasThinking ? <span className="ml-0.5 flex shrink-0 items-center gap-1 text-muted-foreground">
            <span className="model-controls__variant-label max-w-[90px] truncate text-[10px] leading-[14px] -my-[2px] py-[2px]">
              {activeLevel ? formatEffortLabel(activeLevel, { providerId: value.providerId }) : 'Fast'}
            </span>
            {fastState?.fastEnabled ? <RiFlashlightFill aria-label="Fast Mode" className="h-3.5 w-3.5 text-[var(--status-warning)]" /> : null}
          </span> : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="flex w-[min(460px,calc(100vw-2rem))] flex-col p-0" align={align}>
        <div className="flex h-[min(420px,calc(100dvh-12rem))] min-h-0 flex-row">
          <ModelPickerRail
            tabs={tabs}
            activeTabId={view?.tab?.id ?? null}
            dimmed={view?.mode === 'search'}
            onSelectTab={selectTab}
            settingsLabel={t('chat.modelControls.providerSettings')}
            onOpenSettings={openProvidersSettings}
          />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="border-b border-border/40 p-2">
              <div className="relative">
                <RiSearchLine className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  ref={searchInputRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t('chat.modelControls.searchModels')}
                  className="h-8 pl-8 typography-meta"
                  autoFocus
                />
              </div>
            </div>
            <ScrollableOverlay outerClassName="min-h-0 flex-1" className="overlay-scrollbar-target--no-gutter">
              <div className="p-1">
                {view?.mode === 'legacy' ? (
                  <LegacyModelsHeader
                    title={t('chat.modelControls.legacyModels')}
                    backLabel={t('chat.modelControls.backToProviderModels', { provider: view.tab.label })}
                    onBack={() => setLegacyOpen(false)}
                  />
                ) : null}
                {rows.length === 0 ? (
                  <div className="px-2 py-4 text-center typography-meta text-muted-foreground">
                    {t('chat.modelControls.noModelsFound')}
                  </div>
                ) : rows.map((row) => {
                  const option = optionByKey.get(buildModelPickerRefKey(row.providerID, row.modelID));
                  if (!option) return null;
                  const active = option.providerId === value.providerId && option.modelId === displayModelId;
                  return (
                    <button
                      type="button"
                      key={`${option.providerId}:${option.modelId}`}
                      onClick={() => choose(option)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left typography-meta hover:bg-interactive-hover/50 focus:outline-none focus-visible:ring-1 focus-visible:ring-primary',
                        active && 'bg-interactive-hover/30',
                      )}
                    >
                      {showProviderLogo ? <ProviderLogo providerId={option.providerId} className="h-3.5 w-3.5 shrink-0" /> : null}
                      <span className="min-w-0 flex-1 truncate text-foreground">{option.modelName}</span>
                      {active ? <RiCheckLine className="h-4 w-4 shrink-0 text-primary" /> : null}
                    </button>
                  );
                })}
                {view?.mode === 'tab' && view.legacyCount > 0 ? (
                  <LegacyModelsRow
                    title={t('chat.modelControls.legacyModels')}
                    countLabel={t('chat.modelControls.legacyModelCount', { count: view.legacyCount })}
                    highlighted={false}
                    onOpen={() => setLegacyOpen(true)}
                    onPointerActivity={() => undefined}
                  />
                ) : null}
              </div>
            </ScrollableOverlay>
          </div>
        </div>
        {hasThinking ? (
          <div className="shrink-0 border-t border-border/40 px-4 pt-2 pb-3" onKeyDown={(event) => event.stopPropagation()}>
            <ThinkingSlider levels={levels} value={activeLevel} providerId={value.providerId} disabled={disabled} onChange={(effort) => applyThinking({ effort })}
              fastMode={fastState?.canToggleFast ? { enabled: fastState.fastEnabled, onChange: (fastEnabled) => applyThinking({ fastEnabled }) } : undefined} />
          </div>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
