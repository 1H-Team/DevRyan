import React from 'react';
import { RiAddLine, RiArrowLeftSLine, RiArrowRightSLine, RiEyeLine, RiStarFill } from '@remixicon/react';

import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export interface ModelPickerRailTab {
    id: string;
    kind: 'favorites' | 'provider';
    providerID?: string;
    label: string;
}

// Keeps focus in the picker search input so keyboard navigation keeps working after a click.
const keepSearchFocus = (event: React.MouseEvent) => event.preventDefault();

const RailButton: React.FC<{
    label: string;
    active?: boolean;
    onClick: () => void;
    children: React.ReactNode;
}> = ({ label, active = false, onClick, children }) => (
    <Tooltip delayDuration={400}>
        <TooltipTrigger asChild>
            <button
                type="button"
                onMouseDown={keepSearchFocus}
                onClick={onClick}
                aria-label={label}
                aria-pressed={active}
                className={cn(
                    'relative flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg transition-colors',
                    'focus:outline-none focus-visible:ring-1 focus-visible:ring-primary',
                    active ? 'bg-interactive-selection text-foreground' : 'text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground'
                )}
            >
                {children}
                {active ? (
                    <span aria-hidden="true" className="absolute -right-[7px] top-1.5 bottom-1.5 w-[2px] rounded-full bg-primary" />
                ) : null}
            </button>
        </TooltipTrigger>
        <TooltipContent side="left">{label}</TooltipContent>
    </Tooltip>
);

export const ModelPickerRail: React.FC<{
    tabs: readonly ModelPickerRailTab[];
    activeTabId: string | null;
    dimmed: boolean;
    onSelectTab: (tabId: string) => void;
    addProviderLabel: string;
    showAllProvidersLabel: string;
    onAddProvider: () => void;
    onShowAllProviders: () => void;
}> = ({
    tabs,
    activeTabId,
    dimmed,
    onSelectTab,
    addProviderLabel,
    showAllProvidersLabel,
    onAddProvider,
    onShowAllProviders,
}) => {
    const favoritesTab = tabs.find((tab) => tab.kind === 'favorites');
    const providerTabs = tabs.filter((tab) => tab.kind === 'provider');

    return (
        <div className="model-picker-rail flex w-12 flex-shrink-0 flex-col items-center border-r border-border/40 py-1.5">
            <div className={cn(
                'flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
                dimmed && 'opacity-50'
            )}>
                {favoritesTab ? (
                    <>
                        <RailButton
                            label={favoritesTab.label}
                            active={!dimmed && activeTabId === favoritesTab.id}
                            onClick={() => onSelectTab(favoritesTab.id)}
                        >
                            <RiStarFill className="h-[18px] w-[18px]" />
                        </RailButton>
                        {providerTabs.length > 0 ? <span aria-hidden="true" className="my-0.5 h-px w-6 flex-shrink-0 bg-border/50" /> : null}
                    </>
                ) : null}
                {providerTabs.map((tab) => (
                    <RailButton
                        key={tab.id}
                        label={tab.label}
                        active={!dimmed && activeTabId === tab.id}
                        onClick={() => onSelectTab(tab.id)}
                    >
                        {tab.providerID ? (
                            <ProviderLogo providerId={tab.providerID} className="h-[18px] w-[18px]" />
                        ) : null}
                    </RailButton>
                ))}
            </div>
            <div className="mt-1 flex flex-col items-center gap-1 border-t border-border/40 pt-1.5">
                <RailButton label={addProviderLabel} onClick={onAddProvider}>
                    <RiAddLine className="h-4 w-4" />
                </RailButton>
                <RailButton label={showAllProvidersLabel} onClick={onShowAllProviders}>
                    <RiEyeLine className="h-4 w-4" />
                </RailButton>
            </div>
        </div>
    );
};

export const ModelShortcutChip: React.FC<{ modifierLabel: string; index: number }> = ({ modifierLabel, index }) => (
    <kbd
        aria-hidden="true"
        className="model-shortcut-chip flex h-5 min-w-[26px] flex-shrink-0 items-center justify-center rounded-md bg-muted/60 px-1.5 font-sans typography-micro text-muted-foreground"
    >
        {modifierLabel === '⌘' ? `⌘${index}` : `${modifierLabel}+${index}`}
    </kbd>
);

export const LegacyModelsRow = React.forwardRef<HTMLDivElement, {
    title: string;
    countLabel: string;
    highlighted: boolean;
    onOpen: () => void;
    onPointerActivity: (event: React.MouseEvent) => void;
}>(({ title, countLabel, highlighted, onOpen, onPointerActivity }, ref) => (
    <div
        ref={ref}
        role="button"
        tabIndex={-1}
        onMouseDown={keepSearchFocus}
        onClick={onOpen}
        onMouseEnter={onPointerActivity}
        onMouseMove={onPointerActivity}
        className={cn(
            'model-legacy-row flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2',
            highlighted ? 'bg-interactive-selection' : 'hover:bg-interactive-hover/50'
        )}
    >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="typography-meta truncate font-medium text-foreground">{title}</span>
            <span className="typography-micro truncate text-muted-foreground">{countLabel}</span>
        </div>
        <RiArrowRightSLine className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
    </div>
));
LegacyModelsRow.displayName = 'LegacyModelsRow';

export const LegacyModelsHeader: React.FC<{ title: string; backLabel: string; onBack: () => void }> = ({ title, backLabel, onBack }) => (
    <button
        type="button"
        onMouseDown={keepSearchFocus}
        onClick={onBack}
        aria-label={backLabel}
        className="model-legacy-back typography-micro flex w-full items-center gap-1 rounded-md px-1.5 py-1.5 text-left font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-primary"
    >
        <RiArrowLeftSLine className="h-4 w-4 flex-shrink-0" />
        <span className="truncate">{title}</span>
    </button>
);
