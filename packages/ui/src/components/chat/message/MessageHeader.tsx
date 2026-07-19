import React from 'react';
import { RiAiAgentLine, RiBrainAi3Line, RiFlashlightFill, RiUser3Line } from '@remixicon/react';
import { cn } from '@/lib/utils';
import { getAgentColor, getAgentIconColor } from '@/lib/agentColors';
import { useProviderLogo } from '@/hooks/useProviderLogo';
import { ChatMetadataBadge } from '../ChatMetadataBadge';
import { formatAgentLabel, formatEffortLabel } from '../mobileControlsUtils';
import { getMessageHeaderDisplay } from './messageHeaderDisplay';

interface MessageHeaderProps {
    isUser: boolean;
    providerID: string | null;
    modelID?: string | null;
    agentName: string | undefined;
    modelName: string | undefined;
    variant?: string;
    fastEnabled?: boolean;
    isDarkTheme: boolean;
}

const MessageHeader: React.FC<MessageHeaderProps> = ({ isUser, providerID, modelID, agentName, modelName, variant, fastEnabled = false, isDarkTheme }) => {
    const { providerID: displayProviderID, modelName: displayModelName } = React.useMemo(
        () => getMessageHeaderDisplay({ providerID, modelID, modelName }),
        [modelID, modelName, providerID],
    );
    const { src: logoSrc, onError: handleLogoError, hasLogo } = useProviderLogo(displayProviderID);
    const thinkingLabel = variant ? formatEffortLabel(variant, { providerId: providerID }) : undefined;
    const fastIcon = fastEnabled ? (
        <RiFlashlightFill className="h-3 w-3 text-[var(--status-warning)]" aria-label="Fast Mode" />
    ) : null;
    // Keep the provider mark inside the model badge so the row reads: Agent, Model, Thinking.
    const modelBadgeIcon = hasLogo && logoSrc ? (
        <img
            src={logoSrc}
            alt={`${displayProviderID} logo`}
            className="h-4 w-4 flex-shrink-0"
            style={{
                filter: isDarkTheme ? 'brightness(0.9) contrast(1.1) invert(1)' : 'brightness(0.9) contrast(1.1)',
            }}
            onError={handleLogoError}
        />
    ) : (
        <RiBrainAi3Line
            className="h-3 w-3 flex-shrink-0"
            style={{ color: `var(${getAgentColor(agentName).var})` }}
        />
    );

    return (
        <div className={cn('mb-2')}>
            <div className={cn('flex items-center justify-between gap-2')}>
                <div className="flex items-center gap-2">
                    {isUser ? (
                        <div className="flex-shrink-0">
                            <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center">
                                <RiUser3Line className="h-4 w-4 text-primary" />
                            </div>
                        </div>
                    ) : null}
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        {isUser ? (
                            <h3 className="font-bold typography-ui-header tracking-tight leading-none text-primary">You</h3>
                        ) : (
                            <>
                                {agentName ? (
                                    <div
                                        className="flex min-w-0 items-center gap-1.5 typography-ui-header font-bold tracking-tight leading-none"
                                    >
                                        <RiAiAgentLine
                                            className="h-4 w-4 flex-shrink-0 -translate-y-[1px]"
                                            style={{ color: `var(${getAgentIconColor(agentName).var})` }}
                                        />
                                        <span className="min-w-0 max-w-[180px] truncate text-foreground">{formatAgentLabel(agentName)}</span>
                                    </div>
                                ) : null}
                                <ChatMetadataBadge
                                    kind="model"
                                    label={displayModelName || 'Assistant'}
                                    thinkingLabel={thinkingLabel}
                                    isDefaultThinking={thinkingLabel === 'Default'}
                                    icon={modelBadgeIcon}
                                    trailingIcon={fastIcon}
                                    className="agent-badge-combined max-w-[300px]"
                                    labelClassName="max-w-[190px]"
                                />
                            </>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};

export default React.memo(MessageHeader);
