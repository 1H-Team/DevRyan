import React from 'react';
import {
    RiArrowDownSLine,
    RiArrowRightSLine,
    RiInformationLine,
    RiLoader4Line,
    RiScissorsLine,
} from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import type { ContextUsageAvailability } from '@/lib/contextUsagePresentation';
import { resolveDisplaySessionTitle } from '@/lib/sessionTitles';
import type {
    ContextUsageRelatedSession,
    SessionContextUsage,
} from '@/stores/types/sessionTypes';
import { isContextUsageOutsideInteraction } from './contextUsageInteraction';

type ContextSegment = {
    key: string;
    label: string;
    value: number;
    toneClassName: string;
};

interface ContextUsageWindowProps {
    usage: SessionContextUsage | null;
    availability?: ContextUsageAvailability;
    onClose: () => void;
    onCompact?: () => void;
    /** Called when a subagent row without loaded data is expanded, so the host can fetch its messages. */
    onExpandSession?: (sessionId: string) => void;
    triggerRef: React.RefObject<HTMLElement | null>;
}

const formatTokens = (tokens: number): string => {
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
    return Math.round(tokens).toLocaleString();
};

const STAT_TONE_CLASS: Record<string, string> = {
    input: 'bg-sky-500',
    output: 'bg-orange-500',
    reasoning: 'bg-violet-500',
    cacheRead: 'bg-emerald-500',
    cacheWrite: 'bg-pink-500',
    measuredTotal: 'bg-sky-500',
};

const FREE_SPACE_TONE_CLASS = 'bg-muted-foreground/25';
const CONTEXT_WINDOW_CLASS_NAME = 'absolute bottom-[calc(100%+0.625rem)] left-0 z-40 w-[min(24rem,100%)] max-h-[min(60vh,24rem)] overflow-y-auto rounded-xl border border-border/70 bg-[var(--surface-elevated)] p-3';

const formatRowPercent = (value: number, capacity: number | null): string | null => {
    if (capacity === null || capacity <= 0) return null;
    return `${((value / capacity) * 100).toFixed(1)}%`;
};

type SubagentTree = {
    rootRows: ContextUsageRelatedSession[];
    childrenBySession: Map<string, ContextUsageRelatedSession[]>;
};

const buildSubagentTree = (rows: ContextUsageRelatedSession[]): SubagentTree => {
    const rowIds = new Set(rows.map((row) => row.sessionId));
    const rootRows: ContextUsageRelatedSession[] = [];
    const childrenBySession = new Map<string, ContextUsageRelatedSession[]>();
    for (const row of rows) {
        const parent = row.parentSessionId;
        if (parent && rowIds.has(parent)) {
            const collection = childrenBySession.get(parent) ?? [];
            collection.push(row);
            childrenBySession.set(parent, collection);
        } else {
            rootRows.push(row);
        }
    }
    return { rootRows, childrenBySession };
};

const SubagentSessionRow: React.FC<{
    session: ContextUsageRelatedSession;
    childrenBySession: Map<string, ContextUsageRelatedSession[]>;
    expandedIds: Set<string>;
    onToggle: (session: ContextUsageRelatedSession) => void;
    onRequestData?: (sessionId: string) => void;
}> = ({ session, childrenBySession, expandedIds, onToggle, onRequestData }) => {
    const { t } = useI18n();
    const expanded = expandedIds.has(session.sessionId);
    const children = childrenBySession.get(session.sessionId) ?? [];
    const title = resolveDisplaySessionTitle({
        title: session.title,
        fallback: t('contextSidebar.session.untitled'),
    });
    // Request missing child data as soon as the row is expanded (the host
    // dedupes repeat requests).
    React.useEffect(() => {
        if (expanded && session.hasData === false) {
            onRequestData?.(session.sessionId);
        }
    }, [expanded, session.hasData, session.sessionId, onRequestData]);
    // The panel cannot observe the fetch request directly, so show loading copy
    // for a bounded window; some children legitimately have no retained
    // messages (cleaned-up managed tasks) and settle to "Not Measured".
    const [loadingSettled, setLoadingSettled] = React.useState(false);
    React.useEffect(() => {
        if (!expanded || session.hasData !== false) return;
        const timer = window.setTimeout(() => setLoadingSettled(true), 5000);
        return () => window.clearTimeout(timer);
    }, [expanded, session.hasData]);

    const miniSegments: ContextSegment[] = React.useMemo(() => {
        const breakdown = session.tokenBreakdown;
        if (!breakdown) return [];
        return [
            { key: 'input', label: t('contextSidebar.tokens.input'), value: breakdown.input },
            { key: 'cacheRead', label: t('contextSidebar.tokens.cacheRead'), value: breakdown.cacheRead },
            { key: 'cacheWrite', label: t('contextSidebar.tokens.cacheWrite'), value: breakdown.cacheWrite },
        ]
            .filter((row) => row.value > 0)
            .sort((a, b) => b.value - a.value)
            .map((row) => ({ ...row, toneClassName: STAT_TONE_CLASS[row.key] }));
    }, [session.tokenBreakdown, t]);

    const miniDenominator = session.capacityLimit
        ?? miniSegments.reduce((sum, segment) => sum + segment.value, 0);

    return (
        <div>
            <div className="flex items-center gap-2 typography-ui-label text-foreground">
                <button
                    type="button"
                    onClick={() => onToggle(session)}
                    className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    aria-expanded={expanded}
                    aria-label={expanded
                        ? t('contextUsage.window.subagentCollapseAria')
                        : t('contextUsage.window.subagentExpandAria')}
                >
                    <RiArrowRightSLine className={cn('h-4 w-4 transition-transform', expanded ? 'rotate-90' : null)} />
                </button>
                <span className="min-w-0 truncate text-muted-foreground" title={title}>{title}</span>
                <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                    {session.hasData === false
                        ? <span title={t('contextUsage.window.notMeasured')}>—</span>
                        : session.capacityLimit !== null
                            ? `${formatTokens(session.activeInputTokens)} / ${formatTokens(session.capacityLimit)}`
                            : formatTokens(session.activeInputTokens)}
                </span>
            </div>
            {expanded ? (
                <div className="ml-3 mt-1.5 space-y-1.5 border-l border-[var(--interactive-border)] pl-3">
                    {miniSegments.length > 0 ? (
                        <>
                            <div className="flex h-1 w-full gap-px overflow-hidden rounded-full bg-[var(--surface-subtle)]">
                                {miniSegments.map((segment) => {
                                    const width = miniDenominator > 0 ? (segment.value / miniDenominator) * 100 : 0;
                                    if (width <= 0) return null;
                                    return (
                                        <div
                                            key={segment.key}
                                            className={cn('h-full min-w-[2px]', segment.toneClassName)}
                                            style={{ width: `${Math.min(100, Math.max(0.4, width))}%` }}
                                        />
                                    );
                                })}
                                <div className={cn('h-full flex-1', FREE_SPACE_TONE_CLASS)} aria-hidden="true" />
                            </div>
                            {miniSegments.map((segment) => (
                                <div key={segment.key} className="flex items-center gap-2 typography-micro text-muted-foreground">
                                    <span className={cn('h-2 w-2 shrink-0 rounded-[2px]', segment.toneClassName)} aria-hidden="true" />
                                    <span className="min-w-0 truncate">{segment.label}</span>
                                    <span className="ml-auto shrink-0 tabular-nums">{formatTokens(segment.value)}</span>
                                </div>
                            ))}
                        </>
                    ) : (
                        <div className="typography-micro text-muted-foreground">
                            {session.hasData === false && !loadingSettled
                                ? t('contextUsage.window.subagentLoading')
                                : t('contextUsage.window.notMeasured')}
                        </div>
                    )}
                    {children.map((child) => (
                        <SubagentSessionRow
                            key={child.sessionId}
                            session={child}
                            childrenBySession={childrenBySession}
                            expandedIds={expandedIds}
                            onToggle={onToggle}
                            onRequestData={onRequestData}
                        />
                    ))}
                </div>
            ) : null}
        </div>
    );
};

export const ContextUsageWindow: React.FC<ContextUsageWindowProps> = ({
    usage,
    availability,
    onClose,
    onCompact,
    onExpandSession,
    triggerRef,
}) => {
    const { t } = useI18n();
    const paneRef = React.useRef<HTMLDivElement>(null);
    const onCloseRef = React.useRef(onClose);
    onCloseRef.current = onClose;
    const [collapsed, setCollapsed] = React.useState(false);
    const [expandedSubagentIds, setExpandedSubagentIds] = React.useState<Set<string>>(() => new Set());
    const requestedFetchIdsRef = React.useRef<Set<string>>(new Set());
    let effectiveAvailability: ContextUsageAvailability = availability ?? (usage ? 'available' : 'unavailable');
    if (effectiveAvailability === 'available' && !usage) effectiveAvailability = 'unavailable';
    const hasMeasuredUsage = Boolean(usage && effectiveAvailability === 'available');

    const handleToggleSubagent = React.useCallback((session: ContextUsageRelatedSession) => {
        setExpandedSubagentIds((previous) => {
            const next = new Set(previous);
            if (next.has(session.sessionId)) next.delete(session.sessionId);
            else next.add(session.sessionId);
            return next;
        });
    }, []);

    const handleRequestSubagentData = React.useCallback((sessionId: string) => {
        if (!onExpandSession || requestedFetchIdsRef.current.has(sessionId)) return;
        requestedFetchIdsRef.current.add(sessionId);
        onExpandSession(sessionId);
    }, [onExpandSession]);

    React.useEffect(() => {
        const handlePointerDown = (event: PointerEvent) => {
            if (isContextUsageOutsideInteraction(event.target as Node | null, paneRef.current, triggerRef.current)) {
                onCloseRef.current();
            }
        };

        document.addEventListener('pointerdown', handlePointerDown, true);
        return () => document.removeEventListener('pointerdown', handlePointerDown, true);
    }, [triggerRef]);

    const presentation = React.useMemo(() => {
        if (!usage) return null;
        const statSegments: ContextSegment[] = [
            { key: 'input', label: t('contextSidebar.tokens.input'), value: usage.tokenBreakdown.input },
            { key: 'cacheRead', label: t('contextSidebar.tokens.cacheRead'), value: usage.tokenBreakdown.cacheRead },
            { key: 'cacheWrite', label: t('contextSidebar.tokens.cacheWrite'), value: usage.tokenBreakdown.cacheWrite },
        ]
            .filter((row) => row.value > 0)
            .sort((a, b) => b.value - a.value)
            .map((row) => ({ ...row, toneClassName: STAT_TONE_CLASS[row.key] }));

        const fallbackSegments = statSegments.length > 0
            ? statSegments
            : [{
                key: 'measuredTotal',
                label: t('contextUsage.window.measuredTotal'),
                value: usage.activeInputTokens,
                toneClassName: STAT_TONE_CLASS.measuredTotal,
            }];

        const responseSegments: ContextSegment[] = [
            { key: 'output', label: t('contextSidebar.tokens.output'), value: usage.lastOutputTokens },
            { key: 'reasoning', label: t('contextSidebar.tokens.reasoning'), value: usage.tokenBreakdown.reasoning },
        ]
            .filter((row) => row.value > 0)
            .map((row) => ({ ...row, toneClassName: STAT_TONE_CLASS[row.key] }));

        const nextSubagentRows = [...(usage.relatedSubagentSessions ?? [])]
            .filter((session) => session.activeInputTokens > 0 || session.hasData === false);

        return {
            segments: fallbackSegments,
            lastResponseSegments: responseSegments,
            headerUsageLabel: usage.capacityLimit !== null
                ? `${formatTokens(usage.activeInputTokens)} / ${formatTokens(usage.capacityLimit)} (${Math.round(usage.percentage ?? (usage.activeInputTokens / usage.capacityLimit) * 100)}%)`
                : `${formatTokens(usage.activeInputTokens)} ${t('contextUsage.window.tokens')}`,
            freeSpaceTokens: usage.capacityLimit !== null
                ? Math.max(0, usage.capacityLimit - usage.activeInputTokens)
                : null,
            subagentRows: nextSubagentRows,
            subagentTree: buildSubagentTree(nextSubagentRows),
            subagentActiveInputTokens: usage.relatedSubagentActiveInputTokens ?? nextSubagentRows.reduce((sum, session) => sum + session.activeInputTokens, 0),
        };
    }, [t, usage]);

    const segments = presentation?.segments ?? [];
    const lastResponseSegments = presentation?.lastResponseSegments ?? [];
    const headerUsageLabel = presentation?.headerUsageLabel ?? null;
    const freeSpaceTokens = presentation?.freeSpaceTokens ?? null;
    const subagentRows = presentation?.subagentRows ?? [];
    const subagentTree = presentation?.subagentTree ?? buildSubagentTree([]);
    const subagentActiveInputTokens = presentation?.subagentActiveInputTokens ?? 0;
    const hasSubagentRows = subagentRows.length > 0;
    const barDenominator = usage?.capacityLimit ?? segments.reduce((sum, segment) => sum + segment.value, 0);

    let unavailableMessage: string | null = null;
    if (effectiveAvailability === 'idle') {
        unavailableMessage = t('contextUsage.status.noSession');
    } else if (effectiveAvailability === 'loading') {
        unavailableMessage = t('contextUsage.status.loading');
    } else if (effectiveAvailability === 'unavailable') {
        unavailableMessage = t('contextUsage.status.notMeasured');
    }

    if (!hasMeasuredUsage || !usage || !presentation) {
        return (
            <div
                ref={paneRef}
                aria-label={t('contextUsage.window.title')}
                aria-busy={effectiveAvailability === 'loading' || undefined}
                className={CONTEXT_WINDOW_CLASS_NAME}
            >
                <div className="mb-3 typography-ui-label font-medium text-foreground">
                    {t('contextUsage.window.title')}
                </div>
                <div className="flex items-center gap-2 rounded-lg bg-[var(--surface-subtle)]/70 px-2.5 py-2 typography-micro text-muted-foreground">
                    {effectiveAvailability === 'loading' ? (
                        <RiLoader4Line className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
                    ) : (
                        <RiInformationLine className="h-4 w-4 shrink-0" aria-hidden="true" />
                    )}
                    <span>{unavailableMessage}</span>
                </div>
                {onCompact ? (
                    // Rendered disabled rather than omitted: when the compact
                    // affordance simply vanished, an unmeasured session looked
                    // like a session that could not be compacted at all, with
                    // no explanation anywhere in the UI.
                    <div className="mt-3 flex justify-end border-t border-[var(--interactive-border)] pt-3">
                        <Button
                            type="button"
                            variant="outline"
                            size="xs"
                            disabled
                            title={t(effectiveAvailability === 'loading'
                                ? 'contextUsage.window.compactLoading'
                                : 'contextUsage.window.compactUnavailable')}
                            aria-label={t(effectiveAvailability === 'loading'
                                ? 'contextUsage.window.compactLoading'
                                : 'contextUsage.window.compactUnavailable')}
                        >
                            <RiScissorsLine className="h-3.5 w-3.5" />
                            {t('contextUsage.window.compactAction')}
                        </Button>
                    </div>
                ) : null}
            </div>
        );
    }

    return (
        <div
            ref={paneRef}
            aria-label={t('contextUsage.window.title')}
            className={CONTEXT_WINDOW_CLASS_NAME}
        >
            <div className={cn('flex items-center gap-2', collapsed ? null : 'mb-3')}>
                <div className="typography-ui-label font-medium text-foreground">{t('contextUsage.window.title')}</div>
                <span className="ml-auto shrink-0 tabular-nums typography-micro text-muted-foreground">{headerUsageLabel}</span>
                <button
                    type="button"
                    onClick={() => setCollapsed((previous) => !previous)}
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    aria-expanded={!collapsed}
                    aria-label={collapsed ? t('contextUsage.window.expandAria') : t('contextUsage.window.collapseAria')}
                >
                    <RiArrowDownSLine className={cn('h-4 w-4 transition-transform', collapsed ? '-rotate-90' : null)} />
                </button>
            </div>
            {collapsed ? null : (
                <>
                    {usage.capacityLimit === null ? (
                        <div className="mb-3 rounded-lg bg-[var(--surface-subtle)]/70 px-2.5 py-2 typography-micro text-muted-foreground">
                            {t('contextUsage.unavailable.description')}
                        </div>
                    ) : null}
                    <div className="mb-3 flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-[var(--surface-subtle)]">
                        {segments.map((segment) => {
                            const width = barDenominator > 0 ? (segment.value / barDenominator) * 100 : 0;
                            if (width <= 0) return null;
                            return (
                                <div
                                    key={segment.key}
                                    className={cn('h-full min-w-[2px]', segment.toneClassName)}
                                    style={{ width: `${Math.min(100, Math.max(0.4, width))}%` }}
                                />
                            );
                        })}
                        <div className={cn('h-full flex-1', FREE_SPACE_TONE_CLASS)} aria-hidden="true" />
                    </div>
                    <div className="space-y-2">
                        {segments.map((segment) => {
                            const percentLabel = formatRowPercent(segment.value, usage.capacityLimit);
                            return (
                                <div key={segment.key} className="flex items-center gap-2 typography-ui-label text-foreground">
                                    <span className={cn('h-3 w-3 shrink-0 rounded-[3px]', segment.toneClassName)} aria-hidden="true" />
                                    <span className="min-w-0 truncate">{segment.label}</span>
                                    <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{formatTokens(segment.value)}</span>
                                    {percentLabel !== null ? (
                                        <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">{percentLabel}</span>
                                    ) : null}
                                </div>
                            );
                        })}
                        {freeSpaceTokens !== null ? (
                            <div className="flex items-center gap-2 typography-ui-label text-muted-foreground">
                                <span className={cn('h-3 w-3 shrink-0 rounded-[3px]', FREE_SPACE_TONE_CLASS)} aria-hidden="true" />
                                <span className="min-w-0 truncate">{t('contextUsage.window.freeSpace')}</span>
                                <span className="ml-auto shrink-0 tabular-nums">{formatTokens(freeSpaceTokens)}</span>
                                <span className="w-12 shrink-0 text-right tabular-nums">
                                    {formatRowPercent(freeSpaceTokens, usage.capacityLimit)}
                                </span>
                            </div>
                        ) : null}
                    </div>
                    {usage.processedInputTokens !== undefined ? (
                        <div className="mt-3 flex items-center gap-2 border-t border-[var(--interactive-border)] pt-3 typography-ui-label text-muted-foreground">
                            <span>{t('contextUsage.window.processedInput')}</span>
                            <span className="ml-auto tabular-nums">{formatTokens(usage.processedInputTokens)}</span>
                        </div>
                    ) : null}
                    {lastResponseSegments.length > 0 ? (
                        <div className="mt-3 border-t border-[var(--interactive-border)] pt-3">
                            <div className="mb-2 typography-micro font-medium text-muted-foreground">
                                {t('contextUsage.window.lastResponse')}
                            </div>
                            <div className="space-y-2">
                                {lastResponseSegments.map((segment) => (
                                    <div key={segment.key} className="flex items-center gap-2 typography-ui-label text-muted-foreground">
                                        <span className={cn('h-3 w-3 shrink-0 rounded-[3px]', segment.toneClassName)} aria-hidden="true" />
                                        <span>{segment.label}</span>
                                        <span className="ml-auto tabular-nums">{formatTokens(segment.value)}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ) : null}
                    {hasSubagentRows ? (
                        <div className="mt-4 border-t border-[var(--interactive-border)] pt-3">
                            <div className="mb-2 flex items-center justify-between gap-4 typography-micro font-medium text-muted-foreground">
                                <span>{t('contextUsage.window.subagentSessions')}</span>
                                <span className="shrink-0 tabular-nums">~{formatTokens(subagentActiveInputTokens)}</span>
                            </div>
                            <div className="space-y-2">
                                {subagentTree.rootRows.map((session) => (
                                    <SubagentSessionRow
                                        key={session.sessionId}
                                        session={session}
                                        childrenBySession={subagentTree.childrenBySession}
                                        expandedIds={expandedSubagentIds}
                                        onToggle={handleToggleSubagent}
                                        onRequestData={handleRequestSubagentData}
                                    />
                                ))}
                            </div>
                        </div>
                    ) : null}
                    {onCompact ? (() => {
                        // Previously this whole block was omitted whenever usage
                        // had not resolved, so compaction simply looked absent
                        // and its callback returned silently. Render it disabled
                        // with a reason instead of vanishing.
                        const compactDisabled = availability !== 'available';
                        const compactTitle = compactDisabled
                            ? t(availability === 'loading'
                                ? 'contextUsage.window.compactLoading'
                                : 'contextUsage.window.compactUnavailable')
                            : t('contextUsage.window.compactAction');
                        return (
                            <div className="mt-3 flex justify-end border-t border-[var(--interactive-border)] pt-3">
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="xs"
                                    disabled={compactDisabled}
                                    onClick={onCompact}
                                    title={compactTitle}
                                    aria-label={compactTitle}
                                >
                                    <RiScissorsLine className="h-3.5 w-3.5" />
                                    {t('contextUsage.window.compactAction')}
                                </Button>
                            </div>
                        );
                    })() : null}
                </>
            )}
        </div>
    );
};
