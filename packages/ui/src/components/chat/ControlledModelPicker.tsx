import React from 'react';
import { RiCheckLine, RiSearchLine } from '@remixicon/react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useI18n } from '@/lib/i18n';
import {
  getOrderedThinkingVariants,
  resolveProviderModelVariant,
  resolveThinkingVariant,
} from '@/lib/providers/variantControls';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import type { ProviderRecoverySelection } from '@/stores/useProviderRecoveryStore';

import {
  getControlledModelOptions,
  type ControlledModelOption,
  type ControlledModelPickerProvider,
} from './controlledModelPickerOptions';
import { formatEffortLabel } from './mobileControlsUtils';

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
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const options = React.useMemo(
    () => getControlledModelOptions(providers, hiddenModels),
    [hiddenModels, providers],
  );
  const filtered = React.useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return options;
    return options.filter((option) => (
      option.modelName.toLocaleLowerCase().includes(normalized)
      || option.providerName.toLocaleLowerCase().includes(normalized)
    ));
  }, [options, query]);
  const favoriteKeys = React.useMemo(() => new Map(
    favoriteModels.map((favorite, index) => [`${favorite.providerID}:${favorite.modelID}`, index]),
  ), [favoriteModels]);
  const ordered = React.useMemo(() => [...filtered].sort((left, right) => {
    const leftIndex = favoriteKeys.get(`${left.providerId}:${left.modelId}`);
    const rightIndex = favoriteKeys.get(`${right.providerId}:${right.modelId}`);
    if (leftIndex !== undefined || rightIndex !== undefined) {
      return (leftIndex ?? Number.MAX_SAFE_INTEGER) - (rightIndex ?? Number.MAX_SAFE_INTEGER);
    }
    return 0;
  }), [favoriteKeys, filtered]);
  const selected = options.find((option) => (
    option.providerId === value.providerId && option.modelId === value.modelId
  ));
  const grouped = React.useMemo(() => {
    const groups = new Map<string, { name: string; options: ControlledModelOption[] }>();
    for (const option of ordered) {
      const group = groups.get(option.providerId) ?? { name: option.providerName, options: [] };
      group.options.push(option);
      groups.set(option.providerId, group);
    }
    return [...groups.entries()];
  }, [ordered]);

  const choose = (option: ControlledModelOption) => {
    onChange({
      providerId: option.providerId,
      modelId: option.modelId,
      variant: resolveProviderModelVariant(
        option.provider,
        option.modelId,
        option.providerId === value.providerId && option.modelId === value.modelId
          ? value.variant ?? undefined
          : undefined,
      ) ?? null,
    });
    setOpen(false);
  };

  return (
    <DropdownMenu open={open} onOpenChange={(next) => {
      setOpen(next);
      if (!next) setQuery('');
    }}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="model-controls__model-trigger flex h-8 min-w-0 items-center gap-1.5 border-0 bg-transparent p-0 text-left typography-meta font-medium text-foreground hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={t('chat.modelControls.model')}
        >
          <ProviderLogo providerId={selected?.providerId ?? value.providerId} className="h-[17.3px] w-[17.3px] shrink-0" />
          <span className="max-w-[260px] truncate">{selected?.modelName ?? value.modelId}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="flex w-[min(380px,calc(100vw-2rem))] flex-col p-0" align={align}>
        <div className="border-b border-border/40 p-2">
          <div className="relative">
            <RiSearchLine className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('chat.modelControls.searchModels')}
              className="h-8 pl-8 typography-meta"
              autoFocus
            />
          </div>
        </div>
        <ScrollableOverlay outerClassName="max-h-[min(400px,calc(100dvh-12rem))]" className="overlay-scrollbar-target--no-gutter">
          <div className="p-1">
            {grouped.length === 0 ? (
              <div className="px-2 py-4 text-center typography-meta text-muted-foreground">
                {t('chat.modelControls.noModelsFound')}
              </div>
            ) : grouped.map(([providerId, group], groupIndex) => (
              <div key={providerId}>
                {groupIndex > 0 ? <DropdownMenuSeparator /> : null}
                <DropdownMenuLabel className="-mx-1 flex items-center gap-2 border-b border-border/30 px-3 py-1.5 typography-micro font-semibold uppercase tracking-wider text-muted-foreground">
                  <ProviderLogo providerId={providerId} className="h-4 w-4 shrink-0" />
                  <span className="truncate">{group.name}</span>
                </DropdownMenuLabel>
                {group.options.map((option) => {
                  const active = option.providerId === value.providerId && option.modelId === value.modelId;
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
                      <span className="min-w-0 flex-1 truncate text-foreground">{option.modelName}</span>
                      {active ? <RiCheckLine className="h-4 w-4 shrink-0 text-primary" /> : null}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </ScrollableOverlay>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ControlledVariantPicker({
  providers,
  value,
  onChange,
  disabled = false,
}: {
  providers: ControlledModelPickerProvider[];
  value: ProviderRecoverySelection;
  onChange(selection: ProviderRecoverySelection): void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const options = React.useMemo(
    () => getControlledModelOptions(providers, []),
    [providers],
  );
  const selected = options.find((option) => (
    option.providerId === value.providerId && option.modelId === value.modelId
  ));
  const variants = getOrderedThinkingVariants(
    selected?.model && typeof selected.model.variants === 'object'
      ? selected.model.variants as Record<string, unknown>
      : undefined,
    { providerId: value.providerId },
  );
  if (variants.length === 0) return null;

  const activeVariant = resolveThinkingVariant(
    value.variant ?? undefined,
    variants,
    { providerId: value.providerId },
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={t('chat.modelControls.thinking')}
          className="model-controls__variant-trigger flex h-8 min-w-0 shrink-0 items-center border-0 bg-transparent p-0 text-left text-[10px] font-medium leading-[14px] text-muted-foreground hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <span className="max-w-[90px] truncate leading-[14px] -my-[2px] py-[2px]">
            {formatEffortLabel(activeVariant, { providerId: value.providerId })}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[min(210px,calc(100vw-2rem))]">
        <DropdownMenuItem className="typography-meta" onSelect={() => onChange({ ...value, variant: null })}>
          <div className="flex w-full items-center justify-between gap-2">
            <span>{formatEffortLabel(undefined)}</span>
            {activeVariant === undefined ? <RiCheckLine className="h-4 w-4 text-primary" /> : null}
          </div>
        </DropdownMenuItem>
        {variants.map((variant) => (
          <DropdownMenuItem
            key={variant}
            className="typography-meta"
            onSelect={() => onChange({ ...value, variant })}
          >
            <div className="flex w-full min-w-0 items-center justify-between gap-2">
              <span className="min-w-0 truncate font-medium text-foreground">
                {formatEffortLabel(variant, { providerId: value.providerId })}
              </span>
              {variant === activeVariant ? <RiCheckLine className="h-4 w-4 shrink-0 text-primary" /> : null}
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
