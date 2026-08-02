import React from 'react';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import { RiCheckLine, RiFileCopyLine } from '@remixicon/react';
import { LazySyntaxHighlighter as SyntaxHighlighter } from '@/components/chat/LazySyntaxHighlighter';

import { deriveMessageRole } from '@/components/chat/message/messageRole';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { generateSyntaxTheme } from '@/lib/theme/syntaxThemeGenerator';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessions, useSessionMessageRecords } from '@/sync/sync-context';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import { resolveDisplaySessionTitle } from '@/lib/sessionTitles';
import type { ContextUsageSource } from '@/stores/types/sessionTypes';
import { getContextUsageFromMessages } from '@/stores/utils/contextUsageUtils';
import { calculateContextUsage } from '@/stores/utils/contextUtils';
import {
  resolveModelContextCapacity,
  type ResolvedModelContextCapacity,
} from '@/stores/utils/modelContextCapacity';
import { computeCacheHitRate, extractTokenBreakdownFromMessage, type ExtractedTokenBreakdown } from '@/stores/utils/tokenUtils';
import { useUIStore } from '@/stores/useUIStore';
import {
  derivePartsLabel,
  deriveUserSnippet,
  formatAssistantTokens,
  formatMessagePreviewTime,
  truncateMessageId,
} from './rawMessagePreview';

type SessionMessage = { info: Message; parts: Part[] };

type ProviderModelLike = {
  id?: string;
  name?: string;
  limit?: { input?: number; context?: number; output?: number };
  variants?: Record<string, { limit?: { input?: number; context?: number; output?: number } }>;
};

type ProviderLike = {
  id?: string;
  name?: string;
  models?: ProviderModelLike[];
};

type TokenBreakdown = ExtractedTokenBreakdown;

type ContextStatRow = {
  key: string;
  label: string;
  value: number;
};

const EMPTY_BREAKDOWN: TokenBreakdown = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  sourceAccuracy: 'unavailable',
};

const toNonNegativeNumber = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
};

const formatNumber = (value: number): string => value.toLocaleString();

const formatCompactTokens = (tokens: number): string => {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return Math.round(tokens).toLocaleString();
};

const formatMoney = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
};

const formatDateTime = (timestamp: number | null): string => {
  if (!timestamp || !Number.isFinite(timestamp)) return '-';
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};

const SOURCE_COLOR: Record<ContextUsageSource, string> = {
  system: 'var(--surface-muted-foreground)',
  rules: 'var(--status-success)',
  skills: 'var(--status-warning)',
  mcp: 'var(--status-info)',
  subagents: 'var(--interactive-selection)',
  tools: 'var(--primary-base)',
  attachments: 'var(--status-info-border)',
  conversation: 'var(--surface-muted-foreground)',
  other: 'var(--surface-subtle)',
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

const resolveProviderAndModel = (
  providers: ProviderLike[],
  providerID: string,
  modelID: string,
  variant?: string,
): { providerName: string; modelName: string; capacity: ResolvedModelContextCapacity } => {
  const provider = providers.find((entry) => entry.id === providerID);
  const model = provider?.models?.find((entry) => entry.id === modelID);

  return {
    providerName: provider?.name || providerID || '-',
    modelName: model?.name || modelID || '-',
    capacity: resolveModelContextCapacity(model, variant),
  };
};

export const ContextPanelContent: React.FC = () => {
  const { t } = useI18n();
  const timeFormatPreference = useUIStore((s) => s.timeFormatPreference);
  const { currentTheme } = useThemeSystem();
  const syntaxTheme = React.useMemo(() => generateSyntaxTheme(currentTheme), [currentTheme]);
  const [expandedRawMessages, setExpandedRawMessages] = React.useState<Record<string, boolean>>({});
  const [copiedRawMessageId, setCopiedRawMessageId] = React.useState<string | null>(null);
  const copyResetTimeoutRef = React.useRef<number | null>(null);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const getContextUsage = useSessionUIStore((state) => state.getContextUsage);
  const sessions = useSessions();
  const sessionMessages = useSessionMessageRecords(currentSessionId ?? '');
  const providers = useConfigStore((state) => state.providers);

  React.useEffect(() => {
    if (copyResetTimeoutRef.current !== null) {
      window.clearTimeout(copyResetTimeoutRef.current);
      copyResetTimeoutRef.current = null;
    }
    setExpandedRawMessages((prev) => (Object.keys(prev).length > 0 ? {} : prev));
    setCopiedRawMessageId(null);
  }, [currentSessionId]);

  React.useEffect(() => {
    return () => {
      if (copyResetTimeoutRef.current !== null) {
        window.clearTimeout(copyResetTimeoutRef.current);
        copyResetTimeoutRef.current = null;
      }
    };
  }, []);

  const handleCopyRawMessage = React.useCallback(async (messageId: string, value: string) => {
    const result = await copyTextToClipboard(value);
    if (result.ok) {
      setCopiedRawMessageId(messageId);
      if (copyResetTimeoutRef.current !== null) {
        window.clearTimeout(copyResetTimeoutRef.current);
      }
      copyResetTimeoutRef.current = window.setTimeout(() => {
        setCopiedRawMessageId((prev) => (prev === messageId ? null : prev));
        copyResetTimeoutRef.current = null;
      }, 2000);
    } else {
      setCopiedRawMessageId(null);
    }
  }, []);

  const viewModel = React.useMemo(() => {
    const currentSession = currentSessionId ? sessions.find((session) => session.id === currentSessionId) ?? null : null;

    const assistantMessages = sessionMessages.filter((entry) => deriveMessageRole(entry.info).role === 'assistant');
    const userMessages = sessionMessages.filter((entry) => deriveMessageRole(entry.info).isUser);

    let contextMessage: SessionMessage | null = null;
    for (let i = assistantMessages.length - 1; i >= 0; i -= 1) {
      const message = assistantMessages[i];
      if (extractTokenBreakdownFromMessage(message).total > 0) {
        contextMessage = message;
        break;
      }
    }

    const tokenBreakdown = contextMessage ? extractTokenBreakdownFromMessage(contextMessage) : EMPTY_BREAKDOWN;

    const totalAssistantCost = assistantMessages.reduce((sum, message) => {
      const cost = toNonNegativeNumber((message.info as { cost?: unknown }).cost);
      return sum + cost;
    }, 0);

    const latestAssistantInfo = (contextMessage?.info ?? null) as (Message & { providerID?: string; modelID?: string; variant?: string }) | null;
    const providerModel = resolveProviderAndModel(
      providers as ProviderLike[],
      latestAssistantInfo?.providerID || '',
      latestAssistantInfo?.modelID || '',
      latestAssistantInfo?.variant,
    );

    const capacity = providerModel.capacity;
    const sourceUsage = getContextUsage(capacity)
      ?? getContextUsageFromMessages(sessionMessages, capacity);
    const usagePercent = sourceUsage?.percentage
      ?? calculateContextUsage(tokenBreakdown.total, capacity).percentage;
    const sourceSegments = [...(sourceUsage?.sources ?? [])]
      .filter((source) => source.tokens > 0)
      .sort((a, b) => sourceOrder(a.source) - sourceOrder(b.source))
      .map((source) => ({
        key: `${source.source}:${source.label ?? ''}`,
        label: source.label ?? getSourceLabel(source.source, t),
        value: source.tokens,
        color: SOURCE_COLOR[source.source],
      }));
    const sourceTotal = sourceUsage?.sourceTotalTokens ?? sourceSegments.reduce((sum, source) => sum + source.value, 0);
    const usageTokenBreakdown = sourceUsage?.tokenBreakdown ?? tokenBreakdown;
    const detailedTokenStats: ContextStatRow[] = [
      { key: 'input', label: t('contextSidebar.tokens.input'), value: usageTokenBreakdown.input },
      { key: 'output', label: t('contextSidebar.tokens.output'), value: usageTokenBreakdown.output },
      { key: 'reasoning', label: t('contextSidebar.tokens.reasoning'), value: usageTokenBreakdown.reasoning },
      { key: 'cacheRead', label: t('contextSidebar.tokens.cacheRead'), value: usageTokenBreakdown.cacheRead },
      { key: 'cacheWrite', label: t('contextSidebar.tokens.cacheWrite'), value: usageTokenBreakdown.cacheWrite },
    ].filter((row) => row.value > 0);
    const tokenStats = detailedTokenStats.length > 0
      ? detailedTokenStats
      : [{ key: 'measuredTotal', label: t('contextUsage.window.measuredTotal'), value: tokenBreakdown.total }];
    const relatedSubagentSessions = (sourceUsage?.relatedSubagentSessions ?? []).filter((session) => session.totalTokens > 0);
    const relatedSubagentTotalTokens = sourceUsage?.relatedSubagentTotalTokens
      ?? relatedSubagentSessions.reduce((sum, session) => sum + session.totalTokens, 0);

    const firstMessageTs = sessionMessages[0]?.info?.time?.created;
    const lastMessageTs = sessionMessages.length > 0
      ? sessionMessages[sessionMessages.length - 1]?.info?.time?.created
      : null;

    return {
      sessionTitle: resolveDisplaySessionTitle({
        title: currentSession?.title,
        fallback: t('contextSidebar.session.untitled'),
      }),
      messagesCount: sessionMessages.length,
      userMessagesCount: userMessages.length,
      assistantMessagesCount: assistantMessages.length,
      createdAt: (currentSession?.time?.created ?? firstMessageTs ?? null) as number | null,
      lastActivityAt: (lastMessageTs ?? currentSession?.time?.created ?? null) as number | null,
      providerModel,
      tokenBreakdown,
      cacheHitRate: computeCacheHitRate(tokenBreakdown.input, tokenBreakdown.cacheRead, tokenBreakdown.cacheWrite),
      usagePercent,
      totalAssistantCost,
      capacity,
      sourceAccuracy: sourceUsage?.sourceAccuracy ?? 'unavailable',
      sourceSegments,
      sourceTotal,
      tokenStats,
      relatedSubagentSessions,
      relatedSubagentTotalTokens,
    };
  }, [currentSessionId, getContextUsage, providers, sessionMessages, sessions, t]);

  if (!currentSessionId) {
    return (
        <div className="flex h-full items-center justify-center p-6 text-center typography-ui-label text-muted-foreground">
        {t('contextSidebar.empty.openSession')}
      </div>
    );
  }

  const hasSourceSegments = viewModel.sourceAccuracy !== 'unavailable' && viewModel.sourceSegments.length > 0;
  const hasSubagentRows = viewModel.relatedSubagentSessions.length > 0;

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-[52rem] px-5 py-6">

        {/* ── Session header ── */}
        <div className="mb-6">
          <h2 className="typography-ui-header font-semibold text-foreground truncate">{viewModel.sessionTitle}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 typography-micro text-muted-foreground/70">
            <span>{viewModel.providerModel.providerName} / {viewModel.providerModel.modelName}</span>
            {viewModel.createdAt && (
              <>
                <span>&middot;</span>
                <span>{formatDateTime(viewModel.createdAt)}</span>
              </>
            )}
          </div>
        </div>

        {/* ── Context usage ── */}
        <div className="mb-5 rounded-lg bg-[var(--surface-elevated)]/70 px-4 py-3.5">
          <div className="flex items-baseline justify-between">
            <span className="typography-micro text-muted-foreground">{t('contextSidebar.section.context')}</span>
            <span className="typography-micro tabular-nums text-muted-foreground/70">
              {formatNumber(viewModel.tokenBreakdown.total)}
              {viewModel.capacity.capacityLimit !== null
                ? ` / ${formatNumber(viewModel.capacity.capacityLimit)}`
                : ''}
            </span>
          </div>
          <div className="mt-2.5 flex h-1 w-full overflow-hidden rounded-full bg-[var(--surface-subtle)]">
            {viewModel.usagePercent !== null && viewModel.usagePercent > 0 && (
              <div
                className="rounded-full transition-all duration-300"
                style={{
                  width: `${Math.min(100, Math.max(0.5, viewModel.usagePercent))}%`,
                  backgroundColor: viewModel.usagePercent > 80 ? 'var(--status-warning)' : 'var(--primary-base)',
                }}
              />
            )}
          </div>
          <div className="mt-1.5 typography-micro font-medium tabular-nums text-foreground/80">
            {viewModel.usagePercent !== null
              ? t('contextSidebar.context.percentUsed', { percent: viewModel.usagePercent.toFixed(1) })
              : t('contextUsage.unavailable.title')}
          </div>
          {viewModel.capacity.capacityLimit !== null ? (
            <div className="mt-2 space-y-1 typography-micro text-muted-foreground/70">
              <div className="flex items-center justify-between gap-4">
                <span>
                  {viewModel.capacity.capacityBasis === 'input'
                    ? t('contextUsage.window.usableInputCapacity')
                    : t('contextUsage.window.contextFallbackCapacity')}
                </span>
                <span className="tabular-nums">{formatNumber(viewModel.capacity.capacityLimit)}</span>
              </div>
              {viewModel.capacity.contextLimit !== null ? (
                <div className="flex items-center justify-between gap-4">
                  <span>{t('contextUsage.mobile.contextLimit')}</span>
                  <span className="tabular-nums">{formatNumber(viewModel.capacity.contextLimit)}</span>
                </div>
              ) : null}
              {viewModel.capacity.outputLimit !== null ? (
                <div className="flex items-center justify-between gap-4">
                  <span>{t('contextUsage.mobile.outputLimit')}</span>
                  <span className="tabular-nums">{formatNumber(viewModel.capacity.outputLimit)}</span>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="mt-1 space-y-1 typography-micro text-muted-foreground/70">
              <div>{t('contextUsage.unavailable.description')}</div>
              {viewModel.capacity.outputLimit !== null ? (
                <div className="flex items-center justify-between gap-4">
                  <span>{t('contextUsage.mobile.outputLimit')}</span>
                  <span className="tabular-nums">{formatNumber(viewModel.capacity.outputLimit)}</span>
                </div>
              ) : null}
            </div>
          )}
        </div>

        {/* ── Stat grid ── */}
        <div className="mb-5 grid grid-cols-2 gap-2">
          {([
            { label: t('contextSidebar.stats.messages'), value: formatNumber(viewModel.messagesCount) },
            { label: t('contextSidebar.stats.user'), value: formatNumber(viewModel.userMessagesCount) },
            { label: t('contextSidebar.stats.assistant'), value: formatNumber(viewModel.assistantMessagesCount) },
            { label: t('contextSidebar.stats.cost'), value: formatMoney(viewModel.totalAssistantCost) },
          ] as const).map((item) => (
            <div key={item.label} className="rounded-lg bg-[var(--surface-elevated)]/70 px-3 py-2.5">
              <div className="typography-micro text-muted-foreground/70">{item.label}</div>
              <div className="mt-0.5 typography-ui-label tabular-nums text-foreground">{item.value}</div>
            </div>
          ))}
        </div>

        {/* ── Last turn tokens ── */}
        <div className="mb-5 rounded-lg bg-[var(--surface-elevated)]/70 px-4 py-3.5">
          <div className="typography-micro text-muted-foreground">{t('contextSidebar.section.lastAssistantMessage')}</div>
          <div className="mt-1 typography-micro text-muted-foreground/70">{t('contextUsage.window.tokenStatsHelp')}</div>
          <div className="mt-2.5 grid grid-cols-3 gap-x-4 gap-y-2.5">
            {([
              { label: t('contextSidebar.tokens.input'), value: viewModel.tokenBreakdown.input },
              { label: t('contextSidebar.tokens.output'), value: viewModel.tokenBreakdown.output },
              { label: t('contextSidebar.tokens.reasoning'), value: viewModel.tokenBreakdown.reasoning },
              { label: t('contextSidebar.tokens.cacheRead'), value: viewModel.tokenBreakdown.cacheRead },
              { label: t('contextSidebar.tokens.cacheWrite'), value: viewModel.tokenBreakdown.cacheWrite },
              { label: t('contextSidebar.tokens.cacheHit'), value: 0, display: viewModel.cacheHitRate === null ? '—' : `${viewModel.cacheHitRate.toFixed(1)}%` },
            ] as Array<{ label: string; value: number; display?: string }>).map((item) => (
              <div key={item.label}>
                <div className="typography-micro text-muted-foreground/70" title={item.label === t('contextSidebar.tokens.input') ? t('contextUsage.window.tokenStatsHelp') : undefined}>{item.label}</div>
                <div className="mt-0.5 typography-ui-label tabular-nums text-foreground">{item.display ?? formatNumber(item.value)}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Context breakdown ── */}
        <div className="mb-6">
          {hasSourceSegments ? (
            <>
              <div className="flex h-1 w-full overflow-hidden rounded-full bg-[var(--surface-subtle)]">
                {viewModel.sourceSegments.map((segment) => {
                  if (segment.value <= 0 || viewModel.sourceTotal <= 0) return null;
                  return (
                    <div
                      key={segment.key}
                      style={{
                        width: `${(segment.value / viewModel.sourceTotal) * 100}%`,
                        backgroundColor: segment.color,
                      }}
                    />
                  );
                })}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                {viewModel.sourceSegments.map((segment) => {
                  const pct = viewModel.sourceTotal > 0 ? (segment.value / viewModel.sourceTotal) * 100 : 0;
                  return (
                    <div key={segment.key} className="inline-flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: segment.color }} />
                      <span className="typography-micro text-muted-foreground/70">
                        {segment.label} <span className="tabular-nums">{pct.toFixed(0)}%</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="rounded-lg bg-[var(--surface-elevated)]/70 px-4 py-3.5">
              <div className="typography-micro text-muted-foreground">{t('contextUsage.window.tokenStats')}</div>
              <div className="mt-1 typography-micro text-muted-foreground/70">{t('contextUsage.window.tokenStatsHelp')}</div>
              <div className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-2.5">
                {viewModel.tokenStats.map((item) => (
                  <div key={item.key}>
                    <div className="typography-micro text-muted-foreground/70" title={item.key === 'input' ? t('contextUsage.window.tokenStatsHelp') : undefined}>{item.label}</div>
                    <div className="mt-0.5 typography-ui-label tabular-nums text-foreground">{formatNumber(item.value)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {hasSubagentRows ? (
            <div className="mt-5 rounded-lg bg-[var(--surface-elevated)]/70 px-4 py-3.5">
              <div className="flex items-baseline justify-between gap-4">
                <div className="typography-micro text-muted-foreground">{t('contextUsage.window.subagentSessions')}</div>
                <div className="typography-micro tabular-nums text-muted-foreground/70">~{formatCompactTokens(viewModel.relatedSubagentTotalTokens)}</div>
              </div>
              <div className="mt-2.5 space-y-2">
                {viewModel.relatedSubagentSessions.map((session) => (
                  <div key={session.sessionId} className="flex items-center justify-between gap-4 typography-ui-label text-foreground">
                    <span className="truncate text-muted-foreground">
                      {resolveDisplaySessionTitle({
                        title: session.title,
                        fallback: t('contextSidebar.session.untitled'),
                      })}
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {session.capacityLimit !== null
                        ? `${formatCompactTokens(session.totalTokens)} / ${formatCompactTokens(session.capacityLimit)}`
                        : formatCompactTokens(session.totalTokens)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>

        {/* ── Raw messages ── */}
        <div>
          <div className="typography-micro text-muted-foreground">{t('contextSidebar.section.rawMessages')}</div>
          <div className="mt-2.5 space-y-1">
            {[...sessionMessages].reverse().map((message) => {
              const roleInfo = deriveMessageRole(message.info);
              const role = roleInfo.role;
              const isAssistant = role === 'assistant';
              const isUser = roleInfo.isUser;
              const isExpanded = expandedRawMessages[message.info.id] === true;
              const isCopied = copiedRawMessageId === message.info.id;
              const messageCreatedAt = (message.info.time?.created ?? null) as number | null;
              const partsLabel = derivePartsLabel(message.parts);
              const tokens = isAssistant ? extractTokenBreakdownFromMessage({ info: message.info, parts: message.parts }) : null;
              const userSnippet = isUser ? deriveUserSnippet(message.parts) : '';
              const shortId = truncateMessageId(message.info.id);
              const previewTime = formatMessagePreviewTime(messageCreatedAt, timeFormatPreference);
              const assistantLeft = partsLabel || '—';
              const assistantMiddle = tokens ? formatAssistantTokens(tokens.input, tokens.output, formatNumber) : '';
              const otherLeft = role || 'unknown';
              const otherMiddle = partsLabel;

              const jsonValue = isExpanded
                ? JSON.stringify({ info: message.info, parts: message.parts }, null, 2)
                : '';

              return (
                <div
                  key={message.info.id}
                  className="overflow-hidden rounded-lg bg-[var(--surface-elevated)]/70"
                >
                  <button
                    type="button"
                    className="w-full cursor-pointer px-3 py-1.5 text-left hover:bg-[var(--interactive-hover)]"
                    aria-expanded={isExpanded}
                    onClick={() => {
                      setExpandedRawMessages((prev) => ({
                        ...prev,
                        [message.info.id]: !(prev[message.info.id] === true),
                      }));
                    }}
                  >
                    <div
                      className="grid items-center gap-x-2 whitespace-nowrap typography-micro"
                      style={{ gridTemplateColumns: 'auto minmax(0, 1fr) 5rem 4.5rem' }}
                    >
                      {isUser ? (
                        <span
                          className="min-w-0 truncate text-muted-foreground"
                          style={{ gridColumn: 'span 2' }}
                        >
                          <span className="typography-ui-label text-foreground">user:</span>{' '}
                          {userSnippet}
                        </span>
                      ) : (
                        <>
                          <span
                            className={
                              isAssistant
                                ? 'min-w-0 truncate text-muted-foreground'
                                : 'typography-ui-label text-foreground'
                            }
                          >
                            {isAssistant ? assistantLeft : otherLeft}
                          </span>
                          <span
                            className={
                              isAssistant
                                ? 'text-right text-muted-foreground tabular-nums'
                                : 'min-w-0 truncate text-muted-foreground'
                            }
                          >
                            {isAssistant ? assistantMiddle : otherMiddle}
                          </span>
                        </>
                      )}
                      <span className="text-right font-mono text-muted-foreground">{shortId}</span>
                      <span className="text-right text-muted-foreground">{previewTime}</span>
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="border-t border-[var(--surface-subtle)] p-0">
                      <div className="group relative max-h-[26rem] w-full overflow-auto bg-[var(--surface-background)]">
                        <div className="absolute top-1 right-2 z-10 opacity-0 transition-opacity group-hover:opacity-100">
                          <button
                            type="button"
                            className="rounded p-1 text-muted-foreground transition-colors hover:bg-interactive-hover/60 hover:text-foreground"
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleCopyRawMessage(message.info.id, jsonValue);
                            }}
                            aria-label={isCopied ? t('contextSidebar.actions.copied') : t('contextSidebar.actions.copyJson')}
                            title={isCopied ? t('contextSidebar.actions.copied') : t('contextSidebar.actions.copy')}
                          >
                            {isCopied ? <RiCheckLine className="size-3.5" /> : <RiFileCopyLine className="size-3.5" />}
                          </button>
                        </div>
                        <SyntaxHighlighter
                          language="json"
                          style={syntaxTheme}
                          PreTag="div"
                          customStyle={{
                            margin: 0,
                            padding: '0.75rem',
                            background: 'transparent',
                            fontSize: 'var(--text-micro)',
                            lineHeight: '1.35',
                          }}
                          codeTagProps={{
                            style: {
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                              overflowWrap: 'break-word',
                            },
                          }}
                          wrapLongLines
                        >
                          {jsonValue}
                        </SyntaxHighlighter>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
