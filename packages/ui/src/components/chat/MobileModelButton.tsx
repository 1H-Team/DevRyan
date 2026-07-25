import React from 'react';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { getModelDisplayName, getModelThinkingLevelLabel } from './mobileControlsUtils';

interface MobileModelButtonProps {
    onOpenModel: () => void;
    className?: string;
}

export const MobileModelButton: React.FC<MobileModelButtonProps> = ({ onOpenModel, className }) => {
    const currentModelId = useConfigStore((state) => state.currentModelId);
    const currentVariant = useConfigStore((state) => state.currentVariant);
    const getCurrentProvider = useConfigStore((state) => state.getCurrentProvider);
    const currentProvider = getCurrentProvider();
    const modelLabel = getModelDisplayName(currentProvider, currentModelId);
    const modelThinkingLabel = getModelThinkingLevelLabel(currentProvider, currentModelId, currentVariant);
    const title = modelThinkingLabel ? `${modelLabel} · ${modelThinkingLabel}` : modelLabel;

    return (
        <button
            type="button"
            onClick={onOpenModel}
            className={cn(
                'inline-flex min-w-0 max-w-full items-center justify-center overflow-hidden',
                'rounded-md border border-border/50 px-1.5',
                'text-[11px] leading-none font-medium text-foreground/80',
                'focus:outline-none hover:bg-[var(--interactive-hover)]',
                className
            )}
            style={{ height: '23px', maxHeight: '23px', minHeight: '23px' }}
            title={title}
        >
            <span className="flex min-w-0 max-w-full flex-1 items-center whitespace-nowrap overflow-hidden">
                <span className="min-w-0 truncate">{modelLabel}</span>
                {modelThinkingLabel ? <>
                    <span className="mx-1 shrink-0" aria-hidden="true">·</span>
                    <span className="shrink-0">{modelThinkingLabel}</span>
                </> : null}
            </span>
        </button>
    );
};

export default MobileModelButton;
