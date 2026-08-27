import React from 'react';
import { RiAiAgentLine, RiDraftLine } from '@remixicon/react';
import { cn } from '@/lib/utils';
import { useConfigStore, useVisibleConfigAgents } from '@/stores/useConfigStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { getAgentDisplayName } from './mobileControlsUtils';
import { getAgentIconColor } from '@/lib/agentColors';

interface MobileAgentButtonProps {
    onOpenAgentPanel: () => void;
    className?: string;
}

const PLAN_MODE_AGENT_STYLE: React.CSSProperties = { color: 'var(--plan-mode-icon-color)' };

// NOTE: Use pointer events instead of onClick to keep soft keyboard open on mobile
export const MobileAgentButton: React.FC<MobileAgentButtonProps> = ({ onOpenAgentPanel, className }) => {
    const currentAgentName = useConfigStore((state) => state.currentAgentName);
    const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
    const sessionAgentName = useSelectionStore((state) =>
        currentSessionId ? state.getSessionAgentSelection(currentSessionId) : null
    );
    const isPlanModeSelected = useSelectionStore((state) => state.getPlanModeSelection(currentSessionId));

    const agents = useVisibleConfigAgents();
    const rawAgentName = currentSessionId ? (sessionAgentName || currentAgentName) : currentAgentName;
    const uiAgentName = rawAgentName?.trim().toLowerCase() === 'plan' ? undefined : rawAgentName;
    const agentLabel = getAgentDisplayName(agents, uiAgentName);
    const agentIconColor = getAgentIconColor(uiAgentName);

    return (
        <button
            type="button"
            onPointerUp={onOpenAgentPanel}
            onContextMenu={(e) => e.preventDefault()}
            className={cn(
                'inline-flex max-w-full items-center select-none',
                'rounded-md border border-border/50 px-1.5',
                'text-[11px] leading-none font-medium text-foreground',
                'focus:outline-none hover:bg-[var(--interactive-hover)]',
                'touch-none',
                className,
                // Preserve both 12px glyphs, their spacing, padding, and border before labels yield.
                isPlanModeSelected ? 'min-w-[48px]' : 'min-w-[30px]'
            )}
            style={{
                height: '23px',
                maxHeight: '23px',
                minHeight: '23px',
            }}
            title={agentLabel}
        >
            <RiAiAgentLine
                className="mr-1 h-3 w-3 shrink-0"
                style={isPlanModeSelected ? PLAN_MODE_AGENT_STYLE : { color: `var(${agentIconColor.var})` }}
                aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate">{agentLabel}</span>
            {isPlanModeSelected ? <RiDraftLine className="ml-1 h-3 w-3 shrink-0" style={PLAN_MODE_AGENT_STYLE} aria-hidden="true" /> : null}
        </button>
    );
};

export default MobileAgentButton;
