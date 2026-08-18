import React from 'react';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useDeviceInfo } from '@/lib/device';
import { RiArrowDownSLine, RiArrowRightSLine, RiCheckLine, RiCloseLine, RiLoader4Line, RiPencilAiLine, RiSearchLine, RiStarFill, RiStarLine } from '@remixicon/react';
import { cn } from '@/lib/utils';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useModelLists } from '@/hooks/useModelLists';
import {
    getDisplayProviderId,
    getExecutionProviderId,
    getModelDisplayName,
} from '@/lib/providers/antigravity';
import { filterVisibleProviderModelsForPicker } from '@/lib/providers/modelVisibility';
import { shouldHidePairedFastModel } from '@/lib/providers/variantControls';
import { sortProviderTreeForPicker } from '@/lib/providers/sorting';
import { getProviderDisplayName } from '@/lib/providers/display';
import { getProviderModelUnavailableMessage, isProviderModelAvailable } from '@/lib/providers/modelAvailability';
import type { ModelMetadata } from '@/types';
import { useI18n } from '@/lib/i18n';
import { useOpenCodeReadiness } from '@/hooks/useOpenCodeReadiness';
import { getModelSelectorDropdownClassName, getSelectedModelIndex, type ModelSelectorModelRef } from './ModelSelector.utils';

type ProviderModel = Record<string, unknown> & { id?: string; name?: string };

interface ModelSelectorProps {
    providerId: string;
    modelId: string;
    onChange: (providerId: string, modelId: string) => void;
    className?: string;
    allowedProviderIds?: string[];
    placeholder?: string;
    disabled?: boolean;
    selectedLabelDisplay?: 'truncate' | 'wrap';
}

const COMPACT_NUMBER_FORMATTER = new Intl.NumberFormat('en-US', {
    notation: 'compact',
    compactDisplay: 'short',
    maximumFractionDigits: 1,
    minimumFractionDigits: 0,
});

const formatTokens = (value?: number | null) => {
    if (typeof value !== 'number' || Number.isNaN(value)) {
        return '';
    }
    if (value === 0) {
        return '0';
    }
    const formatted = COMPACT_NUMBER_FORMATTER.format(value);
    return formatted.endsWith('.0') ? formatted.slice(0, -2) : formatted;
};

export const ModelSelector: React.FC<ModelSelectorProps> = ({
    providerId,
    modelId,
    onChange,
    className,
    allowedProviderIds,
    placeholder,
    disabled = false,
    selectedLabelDisplay = 'truncate',
}) => {
    const { t } = useI18n();
    const { isReady, isUnavailable } = useOpenCodeReadiness();
    const providers = useConfigStore((state) => state.providers);
    const modelsMetadata = useConfigStore((state) => state.modelsMetadata);
    const isMobile = useUIStore(state => state.isMobile);
    const hiddenModels = useUIStore(state => state.hiddenModels);
    const toggleFavoriteModel = useUIStore((state) => state.toggleFavoriteModel);
    const isFavoriteModel = useUIStore((state) => state.isFavoriteModel);
    const { favoriteModelsList } = useModelLists();
    const { isMobile: deviceIsMobile } = useDeviceInfo();
    const isActuallyMobile = isMobile || deviceIsMobile;

    const [isMobilePanelOpen, setIsMobilePanelOpen] = React.useState(false);
    const [expandedMobileProviders, setExpandedMobileProviders] = React.useState<Set<string>>(new Set());
    const [isDropdownOpen, setIsDropdownOpen] = React.useState(false);
    const [searchQuery, setSearchQuery] = React.useState('');
    const [selectedIndex, setSelectedIndex] = React.useState(0);
    const itemRefs = React.useRef<(HTMLElement | null)[]>([]);

    const allowedProviderSet = React.useMemo(() => {
        if (!Array.isArray(allowedProviderIds) || allowedProviderIds.length === 0) {
            return null;
        }
        return new Set(allowedProviderIds);
    }, [allowedProviderIds]);

    const visibleProviders = React.useMemo(() => {
        const baseProviders = allowedProviderSet
            ? providers.filter((provider) => allowedProviderSet.has(String(provider.id)))
            : providers;

        const filtered = filterVisibleProviderModelsForPicker(
            baseProviders,
            hiddenModels,
            (provider, _model, modelID) => !shouldHidePairedFastModel(
                provider as { id?: string; models?: ProviderModel[] },
                modelID,
            ),
        );
        return sortProviderTreeForPicker(filtered.map((provider) => ({
            ...provider,
            name: getProviderDisplayName(provider),
        })));
    }, [providers, allowedProviderSet, hiddenModels]);

    const closeMobilePanel = () => setIsMobilePanelOpen(false);
    const toggleMobileProviderExpansion = (provId: string) => {
        setExpandedMobileProviders(prev => {
            const newSet = new Set(prev);
            if (newSet.has(provId)) {
                newSet.delete(provId);
            } else {
                newSet.add(provId);
            }
            return newSet;
        });
    };

    // Reset search and selection when dropdown closes
    React.useEffect(() => {
        if (!isDropdownOpen) {
            setSearchQuery('');
            setSelectedIndex(0);
        }
    }, [isDropdownOpen]);

    // Reset selection when search query changes
    React.useEffect(() => {
        setSelectedIndex(0);
    }, [searchQuery]);

    const getTruncatedModelDisplayName = (model: Record<string, unknown>) => {
        const name = getModelDisplayName(model);
        const nameStr = String(name);
        if (nameStr.length > 40) {
            return nameStr.substring(0, 37) + '...';
        }
        return nameStr;
    };

    const getModelMetadata = (provId: string, modId: string): ModelMetadata | undefined => {
        const key = `${provId}/${modId}`;
        return modelsMetadata.get(key);
    };

    const selectedModel = React.useMemo(() => {
        for (const provider of visibleProviders) {
            const providerModels = Array.isArray(provider.models) ? provider.models : [];
            const model = providerModels.find((entry: ProviderModel) => (
                entry.id === modelId
                && getExecutionProviderId(String(provider.id ?? ''), entry) === providerId
            ));
            if (model) {
                return model;
            }
        }

        return undefined;
    }, [modelId, providerId, visibleProviders]);

    const selectedDisplayProviderId = selectedModel
        ? getDisplayProviderId(providerId, selectedModel)
        : providerId;
    const selectedDisplayLabel = selectedModel
        ? getModelDisplayName(selectedModel)
        : (providerId && modelId ? `${providerId}/${modelId}` : '');

    const handleProviderAndModelChange = (newProviderId: string, newModelId: string) => {
        const model = providers
            .find((provider) => provider.id === newProviderId)
            ?.models.find((entry: ProviderModel) => entry.id === newModelId);
        if (model && !isProviderModelAvailable(model)) return;
        onChange(newProviderId, newModelId);
        setIsDropdownOpen(false);
    };

    // Filter helper
    const filterByQuery = (modelName: string, providerName: string) => {
        if (!searchQuery.trim()) return true;
        const lowerQuery = searchQuery.toLowerCase();
        return (
            modelName.toLowerCase().includes(lowerQuery) ||
            providerName.toLowerCase().includes(lowerQuery)
        );
    };

    // Render a model row for desktop dropdown
    const renderModelRow = (
        model: ProviderModel,
        provID: string,
        modID: string,
        keyPrefix: string,
        flatIndex: number,
        isHighlighted: boolean
    ) => {
        const displayProviderId = getDisplayProviderId(provID, model);
        const metadata = getModelMetadata(provID, modID);
        const contextTokens = formatTokens(metadata?.limit?.context);
        const isSelected = providerId === provID && modelId === modID;
        const isFavorite = isFavoriteModel(provID, modID);
        const unavailableMessage = getProviderModelUnavailableMessage(model);

        const showProviderLogo = keyPrefix === 'fav';

        return (
            <DropdownMenuItem
                key={`${keyPrefix}-${provID}-${modID}`}
                ref={(el) => { itemRefs.current[flatIndex] = el; }}
                className={cn(
                    "group flex items-center gap-2",
                    isHighlighted && "bg-interactive-selection",
                    unavailableMessage && "cursor-not-allowed opacity-50"
                )}
                disabled={Boolean(unavailableMessage)}
                title={unavailableMessage}
                onSelect={() => handleProviderAndModelChange(provID, modID)}
                onMouseEnter={() => setSelectedIndex(flatIndex)}
            >
                <div className="flex items-center gap-1.5 flex-1 min-w-0">
                    {showProviderLogo && (
                        <ProviderLogo providerId={displayProviderId} className="h-3.5 w-3.5 flex-shrink-0" />
                    )}
                    <span className="font-medium truncate">
                        {getTruncatedModelDisplayName(model)}
                    </span>
                    {unavailableMessage ? (
                        <span className="typography-micro text-muted-foreground flex-shrink-0">
                            {unavailableMessage}
                        </span>
                    ) : null}
                    {contextTokens ? (
                        <span className="typography-micro text-muted-foreground flex-shrink-0">
                            {contextTokens}
                        </span>
                    ) : null}
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                    {isSelected && (
                        <RiCheckLine className="h-4 w-4 text-primary" />
                    )}
                    <button
                        onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            toggleFavoriteModel(provID, modID);
                        }}
                        className={cn(
                            "model-favorite-button flex h-4 w-4 items-center justify-center hover:text-primary/80",
                            isFavorite ? "text-primary" : "text-muted-foreground"
                        )}
                        aria-label={isFavorite ? t('settings.agents.modelSelector.actions.unfavorite') : t('settings.agents.modelSelector.actions.favorite')}
                        title={isFavorite ? t('settings.agents.modelSelector.actions.removeFromFavorites') : t('settings.agents.modelSelector.actions.addToFavorites')}
                    >
                        {isFavorite ? (
                            <RiStarFill className="h-3.5 w-3.5" />
                        ) : (
                            <RiStarLine className="h-3.5 w-3.5" />
                        )}
                    </button>
                </div>
            </DropdownMenuItem>
        );
    };

    // Filter data for desktop dropdown
    const filteredFavorites = favoriteModelsList.filter(({ model, providerID }) => {
        if (allowedProviderSet && !allowedProviderSet.has(providerID)) {
            return false;
        }
        const provider = providers.find(p => p.id === providerID);
        const providerName = getProviderDisplayName({ id: providerID, name: provider?.name });
        const modelName = getTruncatedModelDisplayName(model);
        return filterByQuery(modelName, providerName);
    });

    const filteredProviders = visibleProviders
        .map((provider) => {
            const providerModels = Array.isArray(provider.models) ? provider.models : [];
            const filteredModels = providerModels.filter((model: ProviderModel) => {
                const modelName = getTruncatedModelDisplayName(model);
                return filterByQuery(modelName, provider.name || provider.id || '');
            });
            return { ...provider, models: filteredModels };
        })
        .filter((provider) => provider.models.length > 0);

    const hasResults = filteredFavorites.length > 0 || filteredProviders.length > 0;
    const flatProviderModelRefs = React.useMemo<ModelSelectorModelRef[]>(() => (
        filteredProviders.flatMap((provider) => (
            (provider.models as ProviderModel[]).map((model) => ({
                providerID: getExecutionProviderId(provider.id as string, model),
                modelID: model.id as string,
            }))
        ))
    ), [filteredProviders]);
    const flatFavoriteModelRefs = React.useMemo<ModelSelectorModelRef[]>(() => (
        filteredFavorites.map(({ providerID, modelID }) => ({ providerID, modelID }))
    ), [filteredFavorites]);
    const selectedModelIndex = React.useMemo(() => (
        getSelectedModelIndex(flatFavoriteModelRefs, flatProviderModelRefs, providerId, modelId)
    ), [flatFavoriteModelRefs, flatProviderModelRefs, providerId, modelId]);

    type FlatModelItem = { model: ProviderModel; providerID: string; modelID: string; section: string };
    const flatModelList = React.useMemo<FlatModelItem[]>(() => {
        const items: FlatModelItem[] = [];

        filteredFavorites.forEach(({ model, providerID, modelID }) => {
            items.push({ model, providerID, modelID, section: 'fav' });
        });
        filteredProviders.forEach((provider) => {
            (provider.models as ProviderModel[]).forEach((model) => {
                items.push({
                    model,
                    providerID: getExecutionProviderId(provider.id as string, model),
                    modelID: model.id as string,
                    section: 'provider',
                });
            });
        });

        return items;
    }, [filteredFavorites, filteredProviders]);

    React.useLayoutEffect(() => {
        if (!isDropdownOpen) {
            return;
        }

        setSelectedIndex(selectedModelIndex);
        window.requestAnimationFrame(() => {
            itemRefs.current[selectedModelIndex]?.scrollIntoView({ block: 'nearest' });
        });
    }, [isDropdownOpen, selectedModelIndex]);

    const renderMobileModelPanel = () => {
        if (!isActuallyMobile) return null;

        return (
            <MobileOverlayPanel
                open={isMobilePanelOpen}
                onClose={closeMobilePanel}
                title={t('settings.agents.modelSelector.title')}
            >
                <div className="space-y-1">
                    {/* Favorites Section for Mobile */}
                    {favoriteModelsList.length > 0 && (
                        <div className="rounded-xl border border-border/40 bg-[var(--surface-elevated)] mb-2">
                            <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                                {t('settings.agents.modelSelector.section.favorites')}
                            </div>
                            <div className="border-t border-border/20">
                                {favoriteModelsList.map(({ model, providerID, modelID }) => {
                                    const isSelectedModel = providerID === providerId && modelID === modelId;
                                    const favoriteDisplayProviderId = getDisplayProviderId(providerID, model);

                                    return (
                                        <div
                                            key={`fav-mobile-${providerID}-${modelID}`}
                                            className={cn(
                                                'flex w-full items-center justify-between px-2 py-1.5 text-left',
                                                'typography-meta',
                                                isSelectedModel ? 'bg-primary/10 text-primary' : 'text-foreground'
                                            )}
                                        >
                                            <button
                                                type="button"
                                                className="flex-1 flex flex-col min-w-0 mr-2"
                                                onClick={() => {
                                                    handleProviderAndModelChange(providerID, modelID);
                                                    closeMobilePanel();
                                                }}
                                            >
                                                <div className="flex items-center gap-2">
                                                    <ProviderLogo
                                                        providerId={favoriteDisplayProviderId}
                                                        className="h-3 w-3 flex-shrink-0"
                                                    />
                                                    <span className="font-medium truncate">{getTruncatedModelDisplayName(model)}</span>
                                                </div>
                                            </button>
                                            
                                            <button
                                                onClick={(e) => {
                                                    e.preventDefault();
                                                    e.stopPropagation();
                                                    toggleFavoriteModel(providerID, modelID);
                                                }}
                                                className="model-favorite-button flex h-8 w-8 items-center justify-center text-primary hover:text-primary/80 active:scale-95 touch-manipulation"
                                                aria-label={t('settings.agents.modelSelector.actions.unfavorite')}
                                            >
                                                <RiStarFill className="h-4 w-4" />
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {visibleProviders.map((provider) => {
                        const providerModels = Array.isArray(provider.models) ? provider.models : [];
                        if (providerModels.length === 0) return null;

                        const isActiveProvider = providerModels.some((modelItem: ProviderModel) => (
                            getExecutionProviderId(provider.id as string, modelItem) === providerId
                            && modelItem.id === modelId
                        ));
                        const isExpanded = expandedMobileProviders.has(provider.id);

                        return (
                            <div key={provider.id} className="rounded-xl border border-border/40 bg-[var(--surface-elevated)]">
                                <button
                                    type="button"
                                    className="flex w-full items-center justify-between gap-1.5 px-2 py-1.5 text-left"
                                    onClick={() => toggleMobileProviderExpansion(provider.id)}
                                >
                                    <div className="flex items-center gap-2">
                                        <ProviderLogo
                                            providerId={provider.id}
                                            className="h-3.5 w-3.5"
                                        />
                                        <span className="typography-meta font-medium text-foreground">
                                            {provider.name}
                                        </span>
                                        {isActiveProvider && (
                                            <span className="typography-micro text-primary/80">{t('settings.agents.modelSelector.badge.current')}</span>
                                        )}
                                    </div>
                                    {isExpanded ? (
                                        <RiArrowDownSLine className="h-3 w-3 text-muted-foreground" />
                                    ) : (
                                        <RiArrowRightSLine className="h-3 w-3 text-muted-foreground" />
                                    )}
                                </button>

                                {isExpanded && (
                                    <div className="border-t border-border/20">
                                        {providerModels.map((modelItem: ProviderModel) => {
                                            const executionProviderId = getExecutionProviderId(provider.id as string, modelItem);
                                            const isSelectedModel = executionProviderId === providerId && modelItem.id === modelId;
                                            const unavailableMessage = getProviderModelUnavailableMessage(modelItem);

                                            return (
                                                <div
                                                    key={modelItem.id as string}
                                                    className={cn(
                                                        'flex w-full items-center justify-between px-2 py-1.5 text-left',
                                                        'typography-meta',
                                                        isSelectedModel ? 'bg-primary/10 text-primary' : 'text-foreground'
                                                        , unavailableMessage && 'opacity-50'
                                                    )}
                                                >
                                                    <button
                                                        type="button"
                                                        className="flex-1 flex flex-col min-w-0 mr-2"
                                                        disabled={Boolean(unavailableMessage)}
                                                        title={unavailableMessage}
                                                        onClick={() => {
                                                            handleProviderAndModelChange(executionProviderId, modelItem.id as string);
                                                            closeMobilePanel();
                                                        }}
                                                    >
                                                        <span className="font-medium truncate">{getTruncatedModelDisplayName(modelItem)}</span>
                                                        {unavailableMessage ? (
                                                            <span className="typography-micro text-muted-foreground">{unavailableMessage}</span>
                                                        ) : null}
                                                    </button>
                                                    
                                                    <div className="flex items-center gap-2 flex-shrink-0">
                                                        <button
                                                            onClick={(e) => {
                                                                e.preventDefault();
                                                                e.stopPropagation();
                                                                toggleFavoriteModel(executionProviderId, modelItem.id as string);
                                                            }}
                                                            className={cn(
                                                                "flex h-8 w-8 items-center justify-center active:scale-95 touch-manipulation hover:text-primary/80",
                                                                isFavoriteModel(executionProviderId, modelItem.id as string)
                                                                    ? "text-primary"
                                                                    : "text-muted-foreground/50"
                                                            )}
                                                            aria-label={isFavoriteModel(executionProviderId, modelItem.id as string)
                                                                ? t('settings.agents.modelSelector.actions.unfavorite')
                                                                : t('settings.agents.modelSelector.actions.favorite')}
                                                        >
                                                            {isFavoriteModel(executionProviderId, modelItem.id as string) ? (
                                                                <RiStarFill className="h-4 w-4" />
                                                            ) : (
                                                                <RiStarLine className="h-4 w-4" />
                                                            )}
                                                        </button>
                                                        
                                                        {isSelectedModel && (
                                                            <div className="h-2 w-2 rounded-full bg-primary" />
                                                        )}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        );
                    })}

                    <button
                        type="button"
                        className="flex w-full items-center justify-between rounded-lg border border-border/40 bg-[var(--surface-elevated)] px-2 py-1.5 text-left"
                        onClick={() => {
                            handleProviderAndModelChange('', '');
                            closeMobilePanel();
                        }}
                    >
                        <span className="typography-meta text-muted-foreground">{placeholder || t('settings.agents.modelSelector.noModelOptional')}</span>
                    </button>
                </div>
            </MobileOverlayPanel>
        );
    };

    return (
        <>
            {isActuallyMobile ? (
                <button
                    type="button"
                    onClick={isReady && !disabled ? () => setIsMobilePanelOpen(true) : undefined}
                    disabled={!isReady || disabled}
                    className={cn(
                        'flex w-full items-center justify-between gap-2 rounded-lg border border-border/40 bg-[var(--surface-elevated)] px-2 py-1.5 text-left',
                        (!isReady || disabled) && 'opacity-60 cursor-not-allowed',
                        className
                    )}
                >
                    <div className="flex items-center gap-2">
                        {!isReady ? (
                            <>
                                <RiLoader4Line className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                                <span className="typography-meta text-muted-foreground">{isUnavailable ? t('common.unavailable') : t('common.loading')}</span>
                            </>
                        ) : providerId ? (
                            <ProviderLogo
                                providerId={selectedDisplayProviderId}
                                className="h-3.5 w-3.5"
                            />
                        ) : (
                            <RiPencilAiLine className="h-3 w-3 text-muted-foreground" />
                        )}
                        {isReady && (
                            <span className="typography-meta font-medium text-foreground">
                                {providerId && modelId ? selectedDisplayLabel : (placeholder || t('settings.agents.modelSelector.selectPlaceholder'))}
                            </span>
                        )}
                    </div>
                    <RiArrowDownSLine className="h-3 w-3 text-muted-foreground" />
                </button>
            ) : (
                <DropdownMenu open={!disabled && isReady && isDropdownOpen} onOpenChange={!disabled && isReady ? setIsDropdownOpen : undefined}>
                    <DropdownMenuTrigger asChild>
                        <div className={cn(
                            'border-input data-[placeholder]:text-muted-foreground flex max-w-full min-w-0 items-center justify-between gap-2 overflow-hidden rounded-lg border bg-transparent px-2 typography-ui-label shadow-none outline-none hover:bg-interactive-hover data-[popup-open]:bg-interactive-active w-fit',
                            selectedLabelDisplay === 'wrap'
                                ? 'min-h-6 py-1.5 whitespace-normal'
                                : 'h-6 py-2 whitespace-nowrap',
                            disabled && 'pointer-events-none cursor-not-allowed opacity-60',
                            className
                        )}>
                            {!isReady ? (
                                <>
                                    <RiLoader4Line className="h-3.5 w-3.5 animate-spin text-muted-foreground flex-shrink-0" />
                                    <span className="typography-ui-label font-normal whitespace-nowrap text-muted-foreground">
                                        {isUnavailable ? t('common.unavailable') : t('common.loading')}
                                    </span>
                                </>
                            ) : (
                                <>
                                    {providerId ? (
                                        <>
                                            <ProviderLogo
                                                providerId={selectedDisplayProviderId}
                                                className="h-3.5 w-3.5 flex-shrink-0"
                                            />
                                            <RiPencilAiLine className="h-3 w-3 text-primary/60 hidden" />
                                        </>
                                    ) : (
                                        <RiPencilAiLine className="h-3.5 w-3.5 text-muted-foreground" />
                                    )}
                                    <span className={cn(
                                        "typography-ui-label min-w-0 font-normal text-foreground",
                                        selectedLabelDisplay === 'wrap'
                                            ? "flex-1 whitespace-normal break-all leading-snug"
                                            : "max-w-full truncate whitespace-nowrap"
                                    )}>
                                        {providerId && modelId ? selectedDisplayLabel : (placeholder || t('settings.agents.modelSelector.notSelected'))}
                                    </span>
                                </>
                            )}
                            <RiArrowDownSLine className="h-4 w-4 flex-shrink-0 text-muted-foreground/50" />
                        </div>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent className={getModelSelectorDropdownClassName()} align="start">
                        {(() => {
                            const totalItems = flatModelList.length;

                            // Handle keyboard navigation
                            const handleKeyDown = (e: React.KeyboardEvent) => {
                                e.stopPropagation();

                                if (e.key === 'ArrowDown') {
                                    e.preventDefault();
                                    const nextIndex = (selectedIndex + 1) % Math.max(1, totalItems);
                                    setSelectedIndex(nextIndex);
                                    setTimeout(() => {
                                        itemRefs.current[nextIndex]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                                    }, 0);
                                } else if (e.key === 'ArrowUp') {
                                    e.preventDefault();
                                    const prevIndex = (selectedIndex - 1 + Math.max(1, totalItems)) % Math.max(1, totalItems);
                                    setSelectedIndex(prevIndex);
                                    setTimeout(() => {
                                        itemRefs.current[prevIndex]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                                    }, 0);
                                } else if (e.key === 'Enter') {
                                    e.preventDefault();
                                    const selectedItem = flatModelList[selectedIndex];
                                    if (selectedItem) {
                                        handleProviderAndModelChange(selectedItem.providerID, selectedItem.modelID);
                                    }
                                } else if (e.key === 'Escape') {
                                    e.preventDefault();
                                    setIsDropdownOpen(false);
                                }
                            };

                            let currentFlatIndex = 0;

                            return (
                                <>
                                    {/* Search Input */}
                                    <div className="p-2 border-b border-border/40">
                                        <div className="relative">
                                            <RiSearchLine className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                                            <Input
                                                type="search"
                                                placeholder={t('settings.agents.modelSelector.searchPlaceholder')}
                                                value={searchQuery}
                                                onChange={(e) => setSearchQuery(e.target.value)}
                                                onKeyDown={handleKeyDown}
                                                className="pl-8 h-8 typography-meta"
                                                autoFocus
                                            />
                                        </div>
                                    </div>

                                    {/* Scrollable content */}
                                    <ScrollableOverlay outerClassName="max-h-[min(400px,calc(100dvh-12rem))] flex-1">
                                        <div className="p-1">
                                            {/* Not selected option */}
                                            <DropdownMenuItem
                                                className={cn(
                                                    "flex items-center gap-2",
                                                )}
                                                onSelect={() => handleProviderAndModelChange('', '')}
                                            >
                                                <RiCloseLine className="h-3.5 w-3.5 text-muted-foreground" />
                                                <span className="text-muted-foreground">{placeholder || t('settings.agents.modelSelector.notSelected')}</span>
                                                {!providerId && !modelId && (
                                                    <RiCheckLine className="h-4 w-4 text-primary ml-auto" />
                                                )}
                                            </DropdownMenuItem>

                                            <DropdownMenuSeparator />

                                            {!hasResults && searchQuery && (
                                                <div className="px-2 py-4 text-center typography-meta text-muted-foreground">
                                                    {t('settings.agents.modelSelector.state.noModelsFound')}
                                                </div>
                                            )}

                                            {/* Favorites Section */}
                                            {filteredFavorites.length > 0 && (
                                                <div>
                                                    <DropdownMenuLabel className="typography-micro font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2 -mx-1 px-3 py-1.5 border-b border-border/30">
                                                        <RiStarFill className="h-4 w-4 text-primary" />
                                                        {t('settings.agents.modelSelector.section.favorites')}
                                                    </DropdownMenuLabel>
                                                    {filteredFavorites.map(({ model, providerID, modelID }) => {
                                                        const idx = currentFlatIndex++;
                                                        return renderModelRow(model, providerID, modelID, 'fav', idx, selectedIndex === idx);
                                                    })}
                                                </div>
                                            )}

                                            {/* Separator before providers */}
                                            {filteredFavorites.length > 0 && filteredProviders.length > 0 && (
                                                <DropdownMenuSeparator />
                                            )}

                                            {/* All Providers - Flat List */}
                                            {filteredProviders.map((provider, index) => (
                                                <div key={provider.id}>
                                                    {index > 0 && <DropdownMenuSeparator />}
                                                    <DropdownMenuLabel className="typography-micro font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2 -mx-1 px-3 py-1.5 border-b border-border/30">
                                                        <ProviderLogo
                                                            providerId={provider.id}
                                                            className="h-4 w-4 flex-shrink-0"
                                                        />
                                                        {provider.name}
                                                    </DropdownMenuLabel>
                                                    {(provider.models as ProviderModel[]).map((model: ProviderModel) => {
                                                        const idx = currentFlatIndex++;
                                                        const executionProviderId = getExecutionProviderId(provider.id as string, model);
                                                        return renderModelRow(model, executionProviderId, model.id as string, 'provider', idx, selectedIndex === idx);
                                                    })}
                                                </div>
                                            ))}
                                        </div>
                                    </ScrollableOverlay>

                                    {/* Keyboard hints footer */}
                                    <div className="px-3 pt-1 pb-1.5 border-t border-border/40 typography-micro text-muted-foreground">
                                        {t('settings.agents.modelSelector.keyboardHints')}
                                    </div>
                                </>
                            );
                        })()}
                    </DropdownMenuContent>
                </DropdownMenu>
            )}
            {renderMobileModelPanel()}
        </>
    );
};
