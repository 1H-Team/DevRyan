import React from 'react';
import { RiAiAgentLine, RiBrainAi3Line } from '@remixicon/react';
import { getAgentColor } from '@/lib/agentColors';
import { cn } from '@/lib/utils';
import { MODEL_BADGE_STYLE } from './chatBadgeStyles';

type ChatMetadataBadgeKind = 'model' | 'agent' | 'thinking';

interface ChatMetadataBadgeProps {
    kind: ChatMetadataBadgeKind;
    label: string;
    thinkingLabel?: string;
    icon?: React.ReactNode;
    trailingIcon?: React.ReactNode;
    agentName?: string;
    isDefaultThinking?: boolean;
    interactive?: boolean;
    className?: string;
    labelClassName?: string;
    style?: React.CSSProperties;
    title?: string;
}

const DEFAULT_THINKING_BADGE_STYLE = {
    '--agent-color': 'var(--surface-muted-foreground)',
    '--agent-color-bg': 'var(--surface-muted-foreground)',
} as React.CSSProperties;

export const ChatMetadataBadge = React.forwardRef<HTMLSpanElement, ChatMetadataBadgeProps>(({
    kind,
    label,
    thinkingLabel,
    icon,
    trailingIcon,
    agentName,
    isDefaultThinking = false,
    interactive = false,
    className,
    labelClassName,
    style,
    title,
}, ref) => {
    const fallbackIcon = kind === 'agent'
        ? <RiAiAgentLine className="h-3 w-3 flex-shrink-0" />
        : kind === 'thinking'
            ? <RiBrainAi3Line className="h-3 w-3 flex-shrink-0" />
            : null;

    const colorClassName = kind === 'agent' && agentName
        ? getAgentColor(agentName).class
        : kind === 'thinking' && !isDefaultThinking
            ? 'agent-info'
            : undefined;

    const colorStyle = kind === 'model'
        ? MODEL_BADGE_STYLE
        : kind === 'agent' && !agentName
            ? DEFAULT_THINKING_BADGE_STYLE
        : kind === 'thinking' && isDefaultThinking
            ? DEFAULT_THINKING_BADGE_STYLE
            : undefined;

    const titleLabel = thinkingLabel ? `${label} ${thinkingLabel}` : label;

    return (
        <span
            ref={ref}
            className={cn(
                'inline-flex h-6 min-w-0 items-center gap-1 rounded-md px-1.5',
                'agent-badge typography-meta font-medium leading-none',
                interactive ? 'cursor-pointer hover:opacity-90' : 'cursor-default',
                className,
                colorClassName,
            )}
            style={{ ...colorStyle, ...style }}
            title={title ?? titleLabel}
        >
            {icon ?? fallbackIcon}
            <span className="inline-flex min-w-0 items-baseline gap-1 leading-none">
                <span className={cn('min-w-0 truncate leading-none', labelClassName)}>{label}</span>
                {thinkingLabel ? (
                    <span
                        className="min-w-0 max-w-[96px] truncate text-[10px] font-medium leading-none text-muted-foreground"
                    >
                        {thinkingLabel}
                    </span>
                ) : null}
                {trailingIcon ? (
                    <span className="inline-flex h-3 w-3 flex-shrink-0 items-center justify-center self-center leading-none">
                        {trailingIcon}
                    </span>
                ) : null}
            </span>
        </span>
    );
});

ChatMetadataBadge.displayName = 'ChatMetadataBadge';

export default ChatMetadataBadge;
