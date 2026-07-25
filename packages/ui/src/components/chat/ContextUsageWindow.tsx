import React from 'react';
import { RiCloseLine, RiScissorsLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import type { ContextUsageSource, SessionContextUsage } from '@/stores/types/sessionTypes';

type ContextSegment = {
    key: string;
    label: string;
    value: number;
    toneClassName: string;
};

type ContextStatRow = {
    key: string;
    label: string;
    value: number;
};

interface ContextUsageWindowProps {
    usage: SessionContextUsage;
    onClose: () => void;
    onCompact?: () => void;
}

const formatTokens = (tokens: number): string => {
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
    return Math.round(tokens).toLocaleString();
};

const SOURCE_TONE_CLASS: Record<ContextUsageSource, string> = {
    system: 'bg-muted-foreground',
    tools: 'bg-[var(--primary-base)]',
    rules: 'bg-[var(--status-success)]',
    skills: 'bg-[var(--status-warning)]',
    mcp: 'bg-[var(--status-info)]',
    subagents: 'bg-[var(--interactive-selection)]',
    conversation: 'bg-[var(--surface-muted-foreground)]',
    attachments: 'bg-[var(--status-info-border)]',
    other: 'bg-[var(--surface-subtle)]',
};

const SOURCE_ORDER: ContextUsageSource[] = [
    'system',
    'rules',
    'skills',
    'mcp',
    'subagents',
    'tools',
    'attachments',
    'conversation',
    'other',
];

const sourceOrder = (source: ContextUsageSource): number => {
    const index = SOURCE_ORDER.indexOf(source);
    return index === -1 ? SOURCE_ORDER.length : index;
};

const getSourceLabel = (source: ContextUsageSource, t: ReturnType<typeof useI18n>['t']): string => {
    switch (source) {
        case 'system': return t('contextUsage.window.systemPrompt');
        case 'rules': return t('contextUsage.window.rules');
        case 'skills': return t('contextUsage.window.skills');
        case 'mcp': return t('contextUsage.window.mcp');
        case 'subagents': return t('contextUsage.window.subagents');
        case 'tools': return t('contextUsage.window.tools');
        case 'attachments': return t('contextUsage.window.attachments');
        case 'conversation': return t('contextUsage.window.conversation');
        case 'other': return t('contextUsage.window.other');
    }
};

export const ContextUsageWindow: React.FC<ContextUsageWindowProps> = ({ usage, onClose, onCompact }) => {
    const { t } = useI18n();

    const {
        segments,
        totalLimitLabel,
        sourceBadgeLabel,
        tokenStats,
        subagentRows,
        subagentTotalTokens,
    } = React.useMemo(() => {
        const nextSegments: ContextSegment[] = [...(usage.sources ?? [])]
            .filter((source) => source.tokens > 0)
            .sort((a, b) => sourceOrder(a.source) - sourceOrder(b.source))
            .map((source) => ({
                key: `${source.source}:${source.label ?? ''}`,
                label: source.label ?? getSourceLabel(source.source, t),
                value: source.tokens,
                toneClassName: SOURCE_TONE_CLASS[source.source],
            }));

        const detailedTokenStats: ContextStatRow[] = [
            { key: 'input', label: t('contextSidebar.tokens.input'), value: usage.tokenBreakdown.input },
            { key: 'output', label: t('contextSidebar.tokens.output'), value: usage.tokenBreakdown.output },
            { key: 'reasoning', label: t('contextSidebar.tokens.reasoning'), value: usage.tokenBreakdown.reasoning },
            { key: 'cacheRead', label: t('contextSidebar.tokens.cacheRead'), value: usage.tokenBreakdown.cacheRead },
            { key: 'cacheWrite', label: t('contextSidebar.tokens.cacheWrite'), value: usage.tokenBreakdown.cacheWrite },
        ].filter((row) => row.value > 0);

        const nextTokenStats = detailedTokenStats.length > 0
            ? detailedTokenStats
            : [{ key: 'measuredTotal', label: t('contextUsage.window.measuredTotal'), value: usage.totalTokens }];

        const subagentRows = [...(usage.relatedSubagentSessions ?? [])]
            .filter((session) => session.totalTokens > 0);

        return {
            segments: nextSegments,
            totalLimitLabel: usage.capacityLimit !== null
                ? `~${formatTokens(usage.totalTokens)} / ${formatTokens(usage.capacityLimit)} ${t('contextUsage.window.tokens')}`
                : `~${formatTokens(usage.totalTokens)} ${t('contextUsage.window.tokens')}`,
            sourceBadgeLabel: usage.sourceAccuracy === 'estimated' ? t('contextUsage.window.sourceEstimated') : null,
            tokenStats: nextTokenStats,
            subagentRows,
            subagentTotalTokens: usage.relatedSubagentTotalTokens ?? subagentRows.reduce((sum, session) => sum + session.totalTokens, 0),
        };
    }, [t, usage.capacityLimit, usage.relatedSubagentSessions, usage.relatedSubagentTotalTokens, usage.sourceAccuracy, usage.sources, usage.tokenBreakdown, usage.totalTokens]);

    const hasSourceSegments = usage.sourceAccuracy !== 'unavailable' && segments.length > 0;
    const hasSubagentRows = subagentRows.length > 0;

    return (
        <div
            aria-label={t('contextUsage.window.title')}
            className="absolute bottom-[calc(100%+0.625rem)] left-0 right-0 z-40 max-h-[min(60vh,24rem)] overflow-y-auto rounded-xl border border-border/70 bg-[var(--surface-elevated)] p-3"
        >
            <div className="mb-3 flex items-center justify-between gap-3">
                <div className="inline-flex min-w-0 items-center gap-2">
                    <div className="typography-ui-label font-medium text-foreground">{t('contextUsage.window.title')}</div>
                    {sourceBadgeLabel ? (
                        <span className="rounded-full border border-[var(--interactive-border)] px-1.5 py-0.5 typography-micro text-muted-foreground">
                            {sourceBadgeLabel}
                        </span>
                    ) : null}
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    aria-label={t('contextUsage.window.closeAria')}
                >
                    <RiCloseLine className="h-4 w-4" />
                </button>
            </div>
            <div className="mb-2 flex items-center justify-between gap-4 typography-micro text-muted-foreground">
                <span>
                    {usage.percentage !== null
                        ? t('contextUsage.window.percentFull', { percent: usage.percentage.toFixed(1) })
                        : t('contextUsage.unavailable.title')}
                </span>
                <span className="tabular-nums">{totalLimitLabel}</span>
            </div>
            {usage.capacityLimit !== null ? (
                <div className="mb-3 space-y-1 rounded-lg bg-[var(--surface-subtle)]/70 px-2.5 py-2 typography-micro text-muted-foreground">
                    <div className="flex items-center justify-between gap-4">
                        <span>
                            {usage.capacityBasis === 'input'
                                ? t('contextUsage.window.usableInputCapacity')
                                : t('contextUsage.window.contextFallbackCapacity')}
                        </span>
                        <span className="tabular-nums text-foreground">{formatTokens(usage.capacityLimit)}</span>
                    </div>
                    {usage.contextLimit !== null ? (
                        <div className="flex items-center justify-between gap-4">
                            <span>{t('contextUsage.mobile.contextLimit')}</span>
                            <span className="tabular-nums text-foreground">{formatTokens(usage.contextLimit)}</span>
                        </div>
                    ) : null}
                    {usage.outputLimit !== null ? (
                        <div className="flex items-center justify-between gap-4">
                            <span>{t('contextUsage.mobile.outputLimit')}</span>
                            <span className="tabular-nums text-foreground">{formatTokens(usage.outputLimit)}</span>
                        </div>
                    ) : null}
                </div>
            ) : (
                <div className="mb-3 space-y-1 rounded-lg bg-[var(--surface-subtle)]/70 px-2.5 py-2 typography-micro text-muted-foreground">
                    <div>{t('contextUsage.unavailable.description')}</div>
                    {usage.outputLimit !== null ? (
                        <div className="flex items-center justify-between gap-4">
                            <span>{t('contextUsage.mobile.outputLimit')}</span>
                            <span className="tabular-nums text-foreground">{formatTokens(usage.outputLimit)}</span>
                        </div>
                    ) : null}
                </div>
            )}
            {hasSourceSegments ? (
                <>
                    <div className="mb-3 flex h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-subtle)]">
                        {segments.map((segment) => {
                            const width = usage.capacityLimit !== null
                                ? (segment.value / usage.capacityLimit) * 100
                                : 0;
                            if (width <= 0) return null;
                            return (
                                <div
                                    key={segment.key}
                                    className={cn('h-full min-w-[2px]', segment.toneClassName)}
                                    style={{ width: `${Math.min(100, Math.max(0.4, width))}%` }}
                                />
                            );
                        })}
                        <div className="h-full flex-1" aria-hidden="true" />
                    </div>
                    <div className="space-y-2">
                        {segments.map((segment) => (
                            <div key={segment.key} className="flex items-center justify-between gap-4 typography-ui-label text-foreground">
                                <span className="inline-flex min-w-0 items-center gap-2">
                                    <span className={cn('h-3 w-3 shrink-0 rounded-[3px]', segment.toneClassName)} aria-hidden="true" />
                                    <span className="truncate">{segment.label}</span>
                                </span>
                                <span className="shrink-0 tabular-nums text-muted-foreground">{formatTokens(segment.value)}</span>
                            </div>
                        ))}
                    </div>
                </>
            ) : (
                <div>
                    <div className="mb-1 typography-micro font-medium text-muted-foreground">{t('contextUsage.window.tokenStats')}</div>
                    <div className="mb-2 typography-micro text-muted-foreground/70">{t('contextUsage.window.tokenStatsHelp')}</div>
                    <div className="space-y-2">
                        {tokenStats.map((stat) => (
                            <div key={stat.key} className="flex items-center justify-between gap-4 typography-ui-label text-foreground">
                                <span className="truncate text-muted-foreground" title={stat.key === 'input' ? t('contextUsage.window.tokenStatsHelp') : undefined}>{stat.label}</span>
                                <span className="shrink-0 tabular-nums text-muted-foreground">{formatTokens(stat.value)}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
            {hasSubagentRows ? (
                <div className="mt-4 border-t border-[var(--interactive-border)] pt-3">
                    <div className="mb-2 flex items-center justify-between gap-4 typography-micro font-medium text-muted-foreground">
                        <span>{t('contextUsage.window.subagentSessions')}</span>
                        <span className="shrink-0 tabular-nums">~{formatTokens(subagentTotalTokens)}</span>
                    </div>
                    <div className="space-y-2">
                        {subagentRows.map((session) => (
                            <div key={session.sessionId} className="flex items-center justify-between gap-4 typography-ui-label text-foreground">
                                <span className="truncate text-muted-foreground">{session.title ?? t('contextSidebar.session.untitled')}</span>
                                <span className="shrink-0 tabular-nums text-muted-foreground">
                                    {session.capacityLimit !== null
                                        ? `${formatTokens(session.totalTokens)} / ${formatTokens(session.capacityLimit)}`
                                        : formatTokens(session.totalTokens)}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            ) : null}
            {onCompact ? (
                <div className="mt-3 flex justify-end border-t border-[var(--interactive-border)] pt-3">
                    <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={onCompact}
                        title={t('contextUsage.window.compactAction')}
                        aria-label={t('contextUsage.window.compactAction')}
                    >
                        <RiScissorsLine className="h-3.5 w-3.5" />
                        {t('contextUsage.window.compactAction')}
                    </Button>
                </div>
            ) : null}
        </div>
    );
};
