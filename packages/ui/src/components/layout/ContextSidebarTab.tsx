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
import { useProviderBackedContextUsage } from '@/hooks/useProviderBackedContextUsage';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import { resolveDisplaySessionTitle } from '@/lib/sessionTitles';
import { getProviderContextUsageFromMessages } from '@/stores/utils/contextUsageUtils';
import { UNAVAILABLE_MODEL_CONTEXT_CAPACITY } from '@/stores/utils/modelContextCapacity';
import { extractTokenBreakdownFromMessage, type ExtractedTokenBreakdown } from '@/stores/utils/tokenUtils';
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

const resolveProviderAndModel = (
  providers: ProviderLike[],
  providerID: string,
  modelID: string,
): { providerName: string; modelName: string } => {
  const provider = providers.find((entry) => entry.id === providerID);
  const model = provider?.models?.find((entry) => entry.id === modelID);

  return {
    providerName: provider?.name || providerID || '-',
    modelName: model?.name || modelID || '-',
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
  const contextUsageDirectory = useEffectiveDirectory() ?? null;
  const getContextUsageForSession = useSessionUIStore((state) => state.getContextUsageForSession);
  const sessions = useSessions(contextUsageDirectory ?? undefined);
  const sessionMessages = useSessionMessageRecords(currentSessionId ?? '', contextUsageDirectory ?? undefined);
  const providers = useConfigStore((state) => state.providers);
  const fallbackContextUsage = React.useMemo(
    () => getContextUsageForSession(currentSessionId, contextUsageDirectory)
      ?? getProviderContextUsageFromMessages(sessionMessages, providers as ProviderLike[]),
    [contextUsageDirectory, currentSessionId, getContextUsageForSession, providers, sessionMessages],
  );
  const contextUsage = useProviderBackedContextUsage({
    sessionID: currentSessionId,
    directory: contextUsageDirectory,
    fallback: fallbackContextUsage,
  });

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

    const totalAssistantCost = assistantMessages.reduce((sum, message) => {
      const cost = toNonNegativeNumber((message.info as { cost?: unknown }).cost);
      return sum + cost;
    }, 0);

    const latestAssistantInfo = (contextMessage?.info ?? null) as (Message & { providerID?: string; modelID?: string; variant?: string }) | null;
    const providerModel = resolveProviderAndModel(
      providers as ProviderLike[],
      latestAssistantInfo?.providerID || '',
      latestAssistantInfo?.modelID || '',
    );

    const capacity = contextUsage
      ? {
          capacityLimit: contextUsage.capacityLimit,
          capacityBasis: contextUsage.capacityBasis,
          inputLimit: contextUsage.inputLimit,
          contextLimit: contextUsage.contextLimit,
          outputLimit: contextUsage.outputLimit,
        }
      : UNAVAILABLE_MODEL_CONTEXT_CAPACITY;
    const usageTokenBreakdown = contextUsage?.tokenBreakdown ?? EMPTY_BREAKDOWN;
    const detailedTokenStats: ContextStatRow[] = [
      { key: 'input', label: t('contextSidebar.tokens.input'), value: usageTokenBreakdown.input },
      { key: 'output', label: t('contextSidebar.tokens.output'), value: usageTokenBreakdown.output },
      { key: 'reasoning', label: t('contextSidebar.tokens.reasoning'), value: usageTokenBreakdown.reasoning },
      { key: 'cacheRead', label: t('contextSidebar.tokens.cacheRead'), value: usageTokenBreakdown.cacheRead },
      { key: 'cacheWrite', label: t('contextSidebar.tokens.cacheWrite'), value: usageTokenBreakdown.cacheWrite },
    ].filter((row) => row.value > 0);
    const tokenStats = detailedTokenStats.length > 0
      ? detailedTokenStats
      : [{ key: 'measuredTotal', label: t('contextUsage.window.measuredTotal'), value: usageTokenBreakdown.total }];
    const relatedSubagentSessions = (contextUsage?.relatedSubagentSessions ?? []).filter((session) => session.activeInputTokens > 0);
    const relatedSubagentActiveInputTokens = contextUsage?.relatedSubagentActiveInputTokens
      ?? relatedSubagentSessions.reduce((sum, session) => sum + session.activeInputTokens, 0);

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
      tokenBreakdown: usageTokenBreakdown,
      usagePercent: contextUsage?.percentage ?? null,
      processedInputTokens: contextUsage?.processedInputTokens ?? null,
      totalAssistantCost,
      capacity,
      freeSpaceTokens: capacity.capacityLimit !== null
        ? Math.max(0, capacity.capacityLimit - usageTokenBreakdown.total)
        : null,
      tokenStats,
      relatedSubagentSessions,
      relatedSubagentActiveInputTokens,
    };
  }, [contextUsage, currentSessionId, providers, sessionMessages, sessions, t]);

  if (!currentSessionId) {
    return (
        <div className="flex h-full items-center justify-center p-6 text-center typography-ui-label text-muted-foreground">
        {t('contextSidebar.empty.openSession')}
      </div>
    );
  }

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
          {viewModel.processedInputTokens !== null ? (
            <div className="mt-2 flex items-center justify-between gap-4 typography-micro text-muted-foreground/70">
              <span>{t('contextUsage.window.processedInput')}</span>
              <span className="tabular-nums">{formatNumber(viewModel.processedInputTokens)}</span>
            </div>
          ) : null}
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
              {viewModel.freeSpaceTokens !== null ? (
                <div className="flex items-center justify-between gap-4">
                  <span>{t('contextUsage.window.freeSpace')}</span>
                  <span className="tabular-nums">{formatNumber(viewModel.freeSpaceTokens)}</span>
                </div>
              ) : null}
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
          <div className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-2.5">
            {viewModel.tokenStats.map((item) => (
              <div key={item.key}>
                <div className="typography-micro text-muted-foreground/70">{item.label}</div>
                <div className="mt-0.5 typography-ui-label tabular-nums text-foreground">{formatNumber(item.value)}</div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Related subagent context ── */}
        <div className="mb-6">
          {hasSubagentRows ? (
            <div className="rounded-lg bg-[var(--surface-elevated)]/70 px-4 py-3.5">
              <div className="flex items-baseline justify-between gap-4">
                <div className="typography-micro text-muted-foreground">{t('contextUsage.window.subagentSessions')}</div>
                <div className="typography-micro tabular-nums text-muted-foreground/70">~{formatCompactTokens(viewModel.relatedSubagentActiveInputTokens)}</div>
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
                        ? `${formatCompactTokens(session.activeInputTokens)} / ${formatCompactTokens(session.capacityLimit)}`
                        : formatCompactTokens(session.activeInputTokens)}
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
