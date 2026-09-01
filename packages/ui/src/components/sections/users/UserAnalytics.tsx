import * as React from 'react';
import {
  RiArrowDownSLine,
  RiBrainLine,
  RiCalendarLine,
  RiChatHistoryLine,
  RiDeleteBinLine,
  RiFileList2Line,
  RiFileSearchLine,
  RiFlashlightLine,
  RiGitBranchLine,
  RiLoader4Line,
  RiRefreshLine,
  RiRobot2Line,
  RiTimeLine,
} from '@remixicon/react';

import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  requestJson,
  selectClassName,
  type ActivityRow,
  type ClipboardAnalyticsDetail,
  type UserAnalyticsEvent,
  type UserAnalyticsEventsPage,
  type UserAnalyticsRange,
  type UserRow,
} from './types';
import { ActivityList } from './ActivitySection';
import { ConfirmActionDialog } from './ConfirmActionDialog';
import {
  formatMinutes,
  formatPromptAgentLabel,
  formatPromptModelLabel,
  formatPromptRowSummary,
  formatPromptThinkingLabel,
  pluralize,
} from './userAnalyticsPresentation';
import { MetricTrendChart } from './MetricTrendChart';
import { DayScrubber } from './DayScrubber';
import {
  groupPromptEventsBySession,
  nextSelectedAnalyticsDate,
  resolveAnalyticsDetailRange,
} from './userAnalyticsState';

const TIME_ZONE_STORAGE_KEY = 'devryan.user-analytics.time-zone';
const RANGE_MAX_DAYS = 92;
const RANGE_PRESETS = [7, 14, 30];

const browserTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

const readTimeZone = (): string => {
  if (typeof window === 'undefined') return 'UTC';
  try {
    return window.localStorage.getItem(TIME_ZONE_STORAGE_KEY) || browserTimeZone();
  } catch {
    return browserTimeZone();
  }
};

const localDate = (timeZone: string): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
};

// The calendar day (YYYY-MM-DD) an ISO instant falls on in the given zone — used to
// bucket prompt/interaction timestamps into the same day keys as series[].date so the
// day-tile selection can filter them client-side.
const localDateOf = (iso: string, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(iso));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
};

const shiftDate = (date: string, amount: number): string => {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
};

const spanDays = (start: string, end: string): number => (
  Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1
);

// Keeps a start/end pair valid: start never after end, and the span capped so the
// server never has to aggregate an unbounded window.
const clampRange = (start: string, end: string): { start: string; end: string } => {
  if (Date.parse(`${end}T00:00:00Z`) < Date.parse(`${start}T00:00:00Z`)) return { start: end, end };
  if (spanDays(start, end) > RANGE_MAX_DAYS) return { start: shiftDate(end, -(RANGE_MAX_DAYS - 1)), end };
  return { start, end };
};

const presetRange = (timeZone: string, days: number): { start: string; end: string } => {
  const end = localDate(timeZone);
  return { start: shiftDate(end, -(days - 1)), end };
};

const timeZones = (): string[] => {
  try {
    const supported = Intl.supportedValuesOf('timeZone');
    return supported.includes('UTC') ? supported : ['UTC', ...supported];
  } catch {
    return ['UTC'];
  }
};

const formatTime = (iso: string, timeZone: string): string => new Intl.DateTimeFormat(undefined, {
  timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit',
}).format(new Date(iso));

const formatSessionDate = (date: string): string => new Intl.DateTimeFormat(undefined, {
  weekday: 'short', month: 'short', day: 'numeric',
}).format(new Date(`${date}T12:00:00`));

const formatSelectedDate = (date: string): string => new Intl.DateTimeFormat(undefined, {
  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
}).format(new Date(`${date}T12:00:00`));

const metadataString = (event: UserAnalyticsEvent, key: string): string => (
  typeof event.metadata?.[key] === 'string' ? event.metadata[key] as string : ''
);

const metadataNumber = (event: UserAnalyticsEvent, key: string): number => (
  typeof event.metadata?.[key] === 'number' ? event.metadata[key] as number : 0
);

const actionLabel = (action: string): string => action
  .split('.')
  .map((part) => part.replaceAll('_', ' '))
  .join(' · ');

const changeDetails = (event: UserAnalyticsEvent): string => {
  if (event.action === 'session.deleted') {
    if (event.success) return 'Archived session permanently deleted · analytics retained indefinitely';
    const upstreamDeleted = event.metadata?.upstreamDeleted === true;
    const ownershipTombstoned = event.metadata?.ownershipTombstoned === true;
    if (upstreamDeleted && !ownershipTombstoned) {
      return 'Session content deleted, but ownership cleanup did not complete';
    }
    return 'Session deletion failed · analytics retained indefinitely';
  }
  const changes = Array.isArray(event.metadata?.changes) ? event.metadata.changes as Array<Record<string, unknown>> : [];
  if (changes.length > 0) {
    return changes.map((change) => {
      const field = String(change.field || 'field');
      if (change.changed === true) return `${field} changed`;
      if (change.before && typeof change.before === 'object' && 'count' in change.before) {
        return `${field}: ${String((change.before as { count?: number }).count ?? 0)} → ${String((change.after as { count?: number } | undefined)?.count ?? 0)}`;
      }
      return `${field}: ${String(change.before ?? 'unset')} → ${String(change.after ?? 'unset')}`;
    }).join('; ');
  }
  if (event.action === 'file.opened') return metadataString(event, 'filePath');
  if (event.action === 'clipboard.copied') {
    const filePath = metadataString(event, 'filePath');
    return `${metadataString(event, 'copyKind') || 'text'} · ${metadataNumber(event, 'characterCount')} characters${filePath ? ` · ${filePath}` : ''}`;
  }
  const fields = Array.isArray(event.metadata?.fields) ? event.metadata.fields.join(', ') : '';
  return fields ? `Updated ${fields}` : 'No additional non-sensitive details';
};

export const ClipboardInteractionDetails: React.FC<{
  event: UserAnalyticsEvent;
  userId: string;
}> = ({ event, userId }) => {
  const summary = event.clipboard;
  const [detail, setDetail] = React.useState<ClipboardAnalyticsDetail | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const controllerRef = React.useRef<AbortController | null>(null);

  React.useEffect(() => () => controllerRef.current?.abort(), []);

  const loadFullText = React.useCallback(async () => {
    if (!summary?.available || detail || loading || !event.event_id) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const payload = await requestJson<ClipboardAnalyticsDetail>(
        `/api/admin/users/${encodeURIComponent(userId)}/analytics/clipboard/${encodeURIComponent(event.event_id)}`,
        { signal: controller.signal },
      );
      if (!controller.signal.aborted) setDetail(payload);
    } catch (caught) {
      if (!controller.signal.aborted) {
        setError(caught instanceof Error ? caught.message : 'Copied text could not be loaded');
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [detail, event.event_id, loading, summary?.available, userId]);

  if (!summary?.available) {
    return (
      <div className="mt-0.5 typography-meta text-muted-foreground">
        {changeDetails(event)} · Text was not captured
      </div>
    );
  }

  return (
    <div className="mt-0.5 min-w-0">
      <div className="typography-meta text-muted-foreground">{changeDetails(event)}</div>
      <div className="mt-1 line-clamp-3 whitespace-pre-wrap break-words rounded-md border border-border/45 bg-[var(--surface-subtle)]/45 px-2 py-1.5 font-mono typography-code text-foreground">
        {summary.preview || '(Empty copied text)'}
      </div>
      <details
        className="group/clipboard mt-1"
        onToggle={(toggleEvent) => {
          if (toggleEvent.currentTarget.open) void loadFullText();
        }}
      >
        <summary className="w-fit cursor-pointer list-none rounded px-1 py-0.5 typography-micro font-medium text-[var(--primary-base)] hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]">
          <span className="group-open/clipboard:hidden">Show full copied text</span>
          <span className="hidden group-open/clipboard:inline">Hide full copied text</span>
        </summary>
        <div className="mt-1 rounded-md border border-border/55 bg-[var(--surface-subtle)]/35 p-2">
          {loading ? (
            <div className="flex items-center gap-1.5 typography-meta text-muted-foreground">
              <RiLoader4Line className="h-3.5 w-3.5 animate-spin" /> Loading copied text…
            </div>
          ) : error ? (
            <div role="alert" className="typography-meta text-[var(--status-error)]">{error}</div>
          ) : detail?.available ? (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono typography-code text-foreground">
              {detail.text || '(Empty copied text)'}
            </pre>
          ) : (
            <div className="typography-meta text-muted-foreground">Text was not captured for this event.</div>
          )}
          {(detail || summary).truncated ? (
            <p className="mt-2 typography-micro text-[var(--status-warning)]">
              Retained text is capped at 64 KiB; the original copy contained {(detail || summary).originalLength.toLocaleString()} characters.
            </p>
          ) : null}
          {(detail || summary).redacted ? (
            <p className="mt-1 typography-micro text-[var(--status-warning)]">
              Sensitive-looking values were redacted before storage.
            </p>
          ) : null}
        </div>
      </details>
    </div>
  );
};

// One figure in the overview strip. Primary metrics (active time, prompts) read
// larger than the secondary counts so the strip has hierarchy instead of five
// equal blocks; the "over N days" context lives once in the strip caption.
const Kpi: React.FC<{ label: string; value: string | number; primary?: boolean }> = ({ label, value, primary }) => (
  <div className="flex flex-col gap-0.5">
    <span className="typography-micro uppercase tracking-wide text-muted-foreground">{label}</span>
    <span className={cn('font-semibold tabular-nums text-foreground', primary ? 'typography-ui-header' : 'typography-ui-label')}>{value}</span>
  </div>
);

const FilterBadge: React.FC<{ label: string }> = ({ label }) => (
  <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[color-mix(in_srgb,var(--primary-base)_35%,transparent)] bg-[color-mix(in_srgb,var(--primary-base)_10%,transparent)] px-2 py-0.5 typography-micro font-medium text-[var(--primary-base)]">
    {label}
  </span>
);

const MetaPill: React.FC<{ icon: React.ReactNode; tip: string; children: React.ReactNode }> = ({ icon, tip, children }) => (
  <span
    title={tip}
    className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-border/50 bg-[var(--surface-subtle)]/50 px-1.5 py-0.5 typography-micro"
  >
    <span className="shrink-0 text-muted-foreground">{icon}</span>
    <span className="min-w-0 truncate text-foreground">{children}</span>
  </span>
);

const StatusPill: React.FC<{ success: boolean }> = ({ success }) => {
  const color = success ? 'var(--status-success)' : 'var(--status-error)';
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 typography-micro font-medium"
      style={{
        color,
        borderColor: `color-mix(in srgb, ${color} 40%, transparent)`,
        backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
      }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
      {success ? 'Succeeded' : 'Failed'}
    </span>
  );
};

const shortSessionId = (sessionId: string): string => (
  sessionId.length <= 22 ? sessionId : `${sessionId.slice(0, 13)}…${sessionId.slice(-6)}`
);

const PromptRow: React.FC<{ event: UserAnalyticsEvent; timeZone: string }> = ({ event, timeZone }) => {
  const provider = metadataString(event, 'providerId');
  const model = metadataString(event, 'modelId');
  const modelLabel = formatPromptModelLabel(provider, model);
  const thinkingLabel = formatPromptThinkingLabel(metadataString(event, 'variant'), provider);
  const agentLabel = formatPromptAgentLabel(metadataString(event, 'agent'));
  const projectName = metadataString(event, 'projectName') || 'Unknown project';
  const branchName = metadataString(event, 'branchName') || 'unknown branch';
  const promptText = metadataString(event, 'promptText');
  const promptSummary = formatPromptRowSummary(promptText);
  const attachmentCount = metadataNumber(event, 'attachmentCount');
  return (
    <details className="group rounded-xl border border-border/60 bg-[var(--surface-elevated)] open:bg-[var(--surface-subtle)]/30">
      <summary className="flex cursor-pointer list-none items-start justify-between gap-3 px-3 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]">
        <div className="min-w-0 flex-1">
          <div className="line-clamp-1 break-words typography-ui-label font-medium text-foreground">
            {promptSummary.title}
          </div>
          {promptSummary.preview ? (
            <p className="mt-0.5 line-clamp-2 break-words typography-meta text-muted-foreground">
              {promptSummary.preview}
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <MetaPill icon={<RiRobot2Line className="h-3 w-3" />} tip="Agent">{agentLabel}</MetaPill>
            <MetaPill icon={<RiBrainLine className="h-3 w-3" />} tip="Model">{modelLabel}</MetaPill>
            <MetaPill icon={<RiFlashlightLine className="h-3 w-3" />} tip="Thinking level">{thinkingLabel}</MetaPill>
            <MetaPill icon={<RiGitBranchLine className="h-3 w-3" />} tip="Repository / branch">{projectName} / {branchName}</MetaPill>
            <MetaPill icon={<RiFileList2Line className="h-3 w-3" />} tip="Attachments (count only)">{pluralize(attachmentCount, 'attachment')}</MetaPill>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 typography-micro text-muted-foreground">
          <span className="inline-flex items-center gap-1"><RiTimeLine className="h-3 w-3" />{formatTime(event.created_at, timeZone)}</span>
          <span className="group-open:hidden">Expand</span>
          <span className="hidden group-open:inline">Collapse</span>
        </div>
      </summary>
      <div className="border-t border-border/50 px-3 py-3">
        <div className="whitespace-pre-wrap break-words font-sans typography-ui-label leading-relaxed text-foreground">{promptText || '(No text parts)'}</div>
        {event.metadata?.promptTruncated === true ? (
          <p className="mt-2 typography-micro text-[var(--status-warning)]">
            Truncated at 16 KiB; original length {metadataNumber(event, 'promptOriginalLength').toLocaleString()} characters.
          </p>
        ) : null}
      </div>
    </details>
  );
};

export const PromptList: React.FC<{
  events: UserAnalyticsEvent[];
  timeZone: string;
  nextCursor: string | null;
  loadingMore: boolean;
  onLoadMore: () => void;
}> = ({ events, timeZone, nextCursor, loadingMore, onLoadMore }) => {
  const groups = groupPromptEventsBySession(events);
  return (
    <div className="space-y-2">
      {groups.length === 0 ? (
      <div className="rounded-xl border border-dashed border-border/70 px-4 py-8 text-center typography-meta text-muted-foreground">
        No prompts match this range and filter set.
      </div>
      ) : groups.map((group) => {
        const newest = group.events[0];
        const projectName = metadataString(newest, 'projectName') || 'Unknown project';
        const branchName = metadataString(newest, 'branchName') || 'unknown branch';
        return (
          <details key={group.key} className="overflow-hidden rounded-xl border border-border/60 bg-[var(--surface-subtle)]/20 [&[open]_.session-chevron]:rotate-180">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-3 transition-colors hover:bg-[var(--surface-subtle)]/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/55 bg-[var(--surface-elevated)] text-muted-foreground">
                  <RiChatHistoryLine className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <div className="truncate typography-ui-label font-semibold text-foreground" title={group.sessionId ?? undefined}>
                    {group.sessionId ? `Session ${shortSessionId(group.sessionId)}` : 'Unattributed prompts'}
                  </div>
                  <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 typography-micro text-muted-foreground">
                    <span className="truncate">{projectName} / {branchName}</span>
                    <span aria-hidden>·</span>
                    <span>{pluralize(group.events.length, 'prompt')} shown</span>
                  </div>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2 typography-micro text-muted-foreground">
                <span className="hidden sm:inline">{formatSessionDate(localDateOf(newest.created_at, timeZone))} · {formatTime(newest.created_at, timeZone)}</span>
                <RiArrowDownSLine className="session-chevron h-4 w-4 transition-transform" />
              </div>
            </summary>
            <div className="space-y-2 border-t border-border/50 bg-[var(--surface-elevated)]/35 p-2">
              {group.events.map((event) => <PromptRow key={event.id} event={event} timeZone={timeZone} />)}
            </div>
          </details>
        );
      })}
      {nextCursor ? (
        <Button variant="outline" size="sm" onClick={onLoadMore} disabled={loadingMore}>
          {loadingMore ? <RiLoader4Line className="h-4 w-4 animate-spin" /> : null} Load 50 More
        </Button>
      ) : null}
    </div>
  );
};

interface UserAnalyticsProps {
  user: UserRow;
  active: boolean;
  canViewDetailed: boolean;
  fallbackActivity: ActivityRow[];
}

export const UserAnalytics: React.FC<UserAnalyticsProps> = ({
  user,
  active,
  canViewDetailed,
  fallbackActivity,
}) => {
  const [timeZone, setTimeZone] = React.useState(readTimeZone);
  const [range, setRange] = React.useState(() => presetRange(readTimeZone(), 14));
  const [selectedDate, setSelectedDate] = React.useState<string | null>(null);
  const [rangeData, setRangeData] = React.useState<UserAnalyticsRange | null>(null);
  const [prompts, setPrompts] = React.useState<UserAnalyticsEvent[]>([]);
  const [interactions, setInteractions] = React.useState<UserAnalyticsEvent[]>([]);
  const [changes, setChanges] = React.useState<UserAnalyticsEvent[]>([]);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [rangeLoading, setRangeLoading] = React.useState(false);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [clearOpen, setClearOpen] = React.useState(false);
  const [clearBusy, setClearBusy] = React.useState(false);
  const [rangeError, setRangeError] = React.useState<string | null>(null);
  const [detailError, setDetailError] = React.useState<string | null>(null);
  const [loadedDetailScope, setLoadedDetailScope] = React.useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = React.useState(0);
  const [filterDraft, setFilterDraft] = React.useState({ search: '', agent: '', model: '' });
  const [filters, setFilters] = React.useState(filterDraft);
  const [showCustom, setShowCustom] = React.useState(false);
  const zones = React.useMemo(timeZones, []);

  // A selected day belongs to one range/time-zone window. Clear it when that
  // window moves so detail requests cannot retain an out-of-scope date.
  React.useEffect(() => {
    setSelectedDate(null);
  }, [range.start, range.end, timeZone]);

  const selectDay = (date: string) => setSelectedDate((current) => nextSelectedAnalyticsDate(current, date));
  const clearDay = () => setSelectedDate(null);

  const rangeQuery = React.useMemo(() => (
    new URLSearchParams({ start: range.start, end: range.end, timeZone })
  ), [range.start, range.end, timeZone]);
  const detailQuery = React.useMemo(() => (
    new URLSearchParams({ ...resolveAnalyticsDetailRange(range, selectedDate), timeZone })
  ), [range, selectedDate, timeZone]);
  const detailScopeKey = JSON.stringify({
    userId: user.id,
    query: detailQuery.toString(),
    filters,
  });
  const detailScopeRef = React.useRef(detailScopeKey);
  detailScopeRef.current = detailScopeKey;

  const activePreset = range.end === localDate(timeZone) ? spanDays(range.start, range.end) : 0;
  // Presets and manual From/To are one control: a preset is "active" only when the
  // window still matches it exactly; otherwise (or once the user opens Custom) the
  // date pickers are revealed so the two mechanisms never compete side by side.
  const presetActive = !showCustom && RANGE_PRESETS.includes(activePreset);
  const customActive = !presetActive;

  const promptUrl = React.useCallback((cursor?: string | null) => {
    const params = new URLSearchParams(detailQuery);
    params.set('category', 'prompts');
    params.set('limit', '50');
    if (filters.search) params.set('search', filters.search);
    if (filters.agent) params.set('agent', filters.agent);
    if (filters.model) params.set('model', filters.model);
    if (cursor) params.set('cursor', cursor);
    return `/api/admin/users/${encodeURIComponent(user.id)}/analytics/events?${params}`;
  }, [detailQuery, filters, user.id]);

  React.useEffect(() => {
    if (!active || !canViewDetailed) return;
    const controller = new AbortController();
    setRangeLoading(true);
    setRangeError(null);
    const rangeUrl = `/api/admin/users/${encodeURIComponent(user.id)}/analytics/range?${rangeQuery}`;
    void requestJson<UserAnalyticsRange>(rangeUrl, { signal: controller.signal })
      .then(setRangeData)
      .catch((caught) => {
        if (controller.signal.aborted) return;
        setRangeError(caught instanceof Error ? caught.message : 'Analytics range could not be loaded');
      })
      .finally(() => {
        if (!controller.signal.aborted) setRangeLoading(false);
      });
    return () => controller.abort();
  }, [active, canViewDetailed, rangeQuery, reloadNonce, user.id]);

  React.useEffect(() => {
    if (!active || !canViewDetailed) return;
    const controller = new AbortController();
    const requestedScope = detailScopeKey;
    setDetailLoading(true);
    setLoadingMore(false);
    setDetailError(null);
    setPrompts([]);
    setNextCursor(null);
    setInteractions([]);
    setChanges([]);
    const eventUrl = (category: 'interactions' | 'changes') => {
      const params = new URLSearchParams(detailQuery);
      params.set('category', category);
      params.set('limit', '100');
      return `/api/admin/users/${encodeURIComponent(user.id)}/analytics/events?${params}`;
    };
    void Promise.all([
      requestJson<UserAnalyticsEventsPage>(promptUrl(), { signal: controller.signal }),
      requestJson<UserAnalyticsEventsPage>(eventUrl('interactions'), { signal: controller.signal }),
      requestJson<UserAnalyticsEventsPage>(eventUrl('changes'), { signal: controller.signal }),
    ]).then(([promptPage, interactionPage, changePage]) => {
      if (detailScopeRef.current !== requestedScope) return;
      setPrompts(promptPage.events);
      setNextCursor(promptPage.nextCursor);
      setInteractions(interactionPage.events);
      setChanges(changePage.events);
      setLoadedDetailScope(requestedScope);
    }).catch((caught) => {
      if (controller.signal.aborted) return;
      setDetailError(caught instanceof Error ? caught.message : 'Analytics detail could not be loaded');
      if (detailScopeRef.current === requestedScope) setLoadedDetailScope(requestedScope);
    }).finally(() => {
      if (!controller.signal.aborted) setDetailLoading(false);
    });
    return () => controller.abort();
  }, [active, canViewDetailed, detailQuery, detailScopeKey, promptUrl, reloadNonce, user.id]);

  const updateTimeZone = (value: string) => {
    setTimeZone(value);
    try { window.localStorage.setItem(TIME_ZONE_STORAGE_KEY, value); } catch { /* Local preference only. */ }
  };

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    const requestedScope = detailScopeKey;
    setLoadingMore(true);
    try {
      const page = await requestJson<UserAnalyticsEventsPage>(promptUrl(nextCursor));
      if (detailScopeRef.current !== requestedScope) return;
      setPrompts((current) => [...current, ...page.events]);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      if (detailScopeRef.current === requestedScope) {
        setDetailError(caught instanceof Error ? caught.message : 'More prompts could not be loaded');
      }
    } finally {
      setLoadingMore(false);
    }
  };

  const clearAnalytics = async () => {
    setClearBusy(true);
    try {
      const result = await requestJson<{ deletedCount: number; remainingCount: number }>(
        `/api/admin/users/${encodeURIComponent(user.id)}/analytics`,
        {
          method: 'DELETE',
          headers: { 'X-DevRyan-CSRF': '1' },
          body: JSON.stringify({ confirm: true }),
        },
      );
      setClearOpen(false);
      setSelectedDate(null);
      setRangeData(null);
      setPrompts([]);
      setInteractions([]);
      setChanges([]);
      setNextCursor(null);
      setLoadedDetailScope(null);
      setReloadNonce((value) => value + 1);
      toast.success(`Cleared all ${result.deletedCount.toLocaleString()} analytics records for this user.`);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'Analytics could not be cleared');
    } finally {
      setClearBusy(false);
    }
  };

  if (!canViewDetailed) {
    return (
      <div className="max-w-4xl space-y-4">
        <div className="rounded-xl border border-border/60 bg-[var(--surface-subtle)]/35 px-4 py-3">
          <h3 className="typography-ui-label font-semibold text-foreground">Administrator analytics</h3>
          <p className="mt-1 typography-meta text-muted-foreground">Prompt and interaction detail is restricted to administrators. Your existing sanitized audit view remains available below.</p>
        </div>
        <ActivityList activity={fallbackActivity} emptyLabel="No recent activity for this user." />
      </div>
    );
  }

  const interactionEvents = [...interactions, ...changes]
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));

  // The range graph stays intact while every detail feed uses the exact selected-day
  // query. This avoids filtering only the first paginated range page client-side.
  const dayFilterActive = selectedDate !== null;
  const selectedDay = selectedDate
    ? rangeData?.series.find((day) => day.date === selectedDate) ?? null
    : null;
  const displayTotals = dayFilterActive
    ? selectedDay ?? { estimatedActiveMinutes: 0, prompts: 0, filesOpened: 0, copies: 0, settingsChanges: 0 }
    : rangeData?.totals ?? { estimatedActiveMinutes: 0, prompts: 0, filesOpened: 0, copies: 0, settingsChanges: 0 };

  const sessionCountByDate = new Map<string, number>();
  rangeData?.activitySessions.forEach((session) => {
    sessionCountByDate.set(session.date, (sessionCountByDate.get(session.date) ?? 0) + 1);
  });
  const visibleSessions = rangeData
    ? (selectedDate ? rangeData.activitySessions.filter((session) => session.date === selectedDate) : rangeData.activitySessions)
    : [];
  const filterNote = selectedDate ? `Filtered to ${formatSelectedDate(selectedDate)}` : null;
  const loading = rangeLoading || detailLoading;
  const error = rangeError || detailError;
  const detailPending = detailLoading || loadedDetailScope !== detailScopeKey;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-[var(--surface-subtle)]/25 p-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div role="group" aria-label="Date Range" className="inline-flex items-center gap-0.5 rounded-[10px] border border-border/60 bg-[color-mix(in_srgb,var(--foreground)_2%,transparent)] p-0.5">
            {RANGE_PRESETS.map((days) => {
              const active = presetActive && activePreset === days;
              return (
                <button
                  key={days}
                  type="button"
                  aria-pressed={active}
                  aria-label={`Last ${days} days`}
                  onClick={() => { setShowCustom(false); setRange(presetRange(timeZone, days)); }}
                  className={cn(
                    'rounded-lg px-3 py-1.5 typography-micro font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
                    active
                      ? 'bg-[var(--surface-elevated)] text-foreground shadow-sm'
                      : 'bg-transparent text-muted-foreground hover:text-foreground',
                  )}
                >
                  {`${days}d`}
                </button>
              );
            })}
            <button
              type="button"
              aria-pressed={customActive}
              onClick={() => setShowCustom(true)}
              className={cn(
                'rounded-lg px-3 py-1.5 typography-micro font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
                customActive
                  ? 'bg-[var(--surface-elevated)] text-foreground shadow-sm'
                  : 'bg-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              Custom
            </button>
          </div>
          {customActive ? (
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1 typography-micro text-muted-foreground">
                <span>From</span>
                <div className="relative">
                  <RiCalendarLine className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input type="date" value={range.start} max={range.end} onChange={(event) => setRange((current) => clampRange(event.target.value, current.end))} className="w-40 pl-8" />
                </div>
              </label>
              <label className="flex flex-col gap-1 typography-micro text-muted-foreground">
                <span>To</span>
                <div className="relative">
                  <RiCalendarLine className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input type="date" value={range.end} min={range.start} onChange={(event) => setRange((current) => clampRange(current.start, event.target.value))} className="w-40 pl-8" />
                </div>
              </label>
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select aria-label="Analytics Time Zone" className={cn(selectClassName, 'w-44')} value={timeZone} onChange={(event) => updateTimeZone(event.target.value)}>
            {!zones.includes(timeZone) ? <option value={timeZone}>{timeZone}</option> : null}
            {zones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
          </select>
          <Button variant="outline" onClick={() => setReloadNonce((value) => value + 1)} disabled={loading} aria-label="Refresh Analytics">
            <RiRefreshLine className={cn('h-4 w-4', loading && 'animate-spin')} /> Refresh
          </Button>
          <Button variant="destructive" onClick={() => setClearOpen(true)} disabled={loading || clearBusy}>
            <RiDeleteBinLine className="h-4 w-4" /> Clear All Analytics
          </Button>
        </div>
      </div>

      <ConfirmActionDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        title="Clear All User Analytics"
        description={`Permanently clear all current prompt, interaction, and safe change analytics for ${user.display_name}? The administrative purge marker will remain in the audit log.`}
        confirmLabel="Clear All Analytics"
        destructive
        busy={clearBusy}
        onConfirm={() => void clearAnalytics()}
      />

      {error ? (
        <div role="alert" className="rounded-xl border border-[var(--status-error)]/35 bg-[var(--status-error)]/10 px-4 py-3 typography-meta text-foreground">
          <div className="font-medium">Analytics could not be loaded</div>
          <div className="mt-1 text-muted-foreground">{error}</div>
        </div>
      ) : null}

      {rangeLoading && !rangeData ? (
        <div className="flex min-h-64 items-center justify-center gap-2 typography-meta text-muted-foreground">
          <RiLoader4Line className="h-4 w-4 animate-spin" /> Loading analytics…
        </div>
      ) : rangeData ? (
        <>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span className="typography-micro uppercase tracking-wide text-muted-foreground">
                {selectedDate
                  ? `Selected · ${formatSelectedDate(selectedDate)}`
                  : `Range totals · over ${rangeData.days} ${rangeData.days === 1 ? 'day' : 'days'}`}
              </span>
              {selectedDate ? (
                <button
                  type="button"
                  onClick={clearDay}
                  className="shrink-0 rounded-md px-2 py-1 typography-micro font-medium text-[var(--primary-base)] transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
                >
                  Clear Selection
                </button>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl border border-border/60 bg-[var(--surface-elevated)] px-4 py-3">
              <Kpi label="Active time" value={formatMinutes(displayTotals.estimatedActiveMinutes)} primary />
              <Kpi label="Prompts" value={displayTotals.prompts} primary />
              <span className="hidden h-8 w-px self-center bg-border/60 sm:block" aria-hidden />
              <Kpi label="Files opened" value={displayTotals.filesOpened} />
              <Kpi label="Copies" value={displayTotals.copies} />
              <Kpi label="Settings changes" value={displayTotals.settingsChanges} />
            </div>
          </div>

          <section className="space-y-3" aria-labelledby="activity-graph-heading">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <div>
                <h3 id="activity-graph-heading" className="typography-ui-header font-semibold text-foreground">Activity Graph</h3>
                <p className="typography-meta text-muted-foreground">Daily totals across the range. Toggle metrics on or off; hover for exact values. Select a day on the rail below to focus every section.</p>
              </div>
              {selectedDate ? (
                <button
                  type="button"
                  onClick={clearDay}
                  className="shrink-0 rounded-md px-2 py-1 typography-micro font-medium text-[var(--primary-base)] transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
                >
                  {`${formatSessionDate(selectedDate)} · Clear`}
                </button>
              ) : (
                <span className="shrink-0 typography-micro text-muted-foreground">{`${rangeData.days}-day range`}</span>
              )}
            </div>
            <MetricTrendChart series={rangeData.series} selectedDate={selectedDate} />
            <DayScrubber
              series={rangeData.series}
              selectedDate={selectedDate}
              onSelect={selectDay}
              sessionCountByDate={sessionCountByDate}
            />
          </section>

          <section className="space-y-3" aria-labelledby="activity-sessions-heading">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <div>
                <h3 id="activity-sessions-heading" className="typography-ui-header font-semibold text-foreground">Activity Sessions</h3>
                <p className="typography-meta text-muted-foreground">Individual work blocks, split after gaps greater than 30 minutes with a five-minute tail.</p>
              </div>
              {filterNote ? <FilterBadge label={filterNote} /> : null}
            </div>
            {visibleSessions.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border/70 px-4 py-8 text-center typography-meta text-muted-foreground">
                {dayFilterActive ? 'No direct activity on the selected day.' : 'No direct activity in this range.'}
              </div>
            ) : (
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {visibleSessions.map((session) => (
                  <div key={session.id + session.date} className="rounded-xl border border-border/60 bg-[var(--surface-elevated)] px-3 py-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="typography-ui-label font-medium text-foreground">{formatTime(session.start, timeZone)}–{formatTime(session.end, timeZone)}</span>
                      <span className="typography-meta font-semibold text-foreground">≈ {formatMinutes(session.estimatedMinutes)}</span>
                    </div>
                    <div className="mt-0.5 typography-micro text-muted-foreground">{formatSessionDate(session.date)}</div>
                    <p className="mt-1 typography-micro text-muted-foreground">
                      {pluralize(session.actionCount, 'action')} · {pluralize(session.counts.prompts, 'prompt')} · {pluralize(session.counts.filesOpened, 'file')} · {pluralize(session.counts.copies, 'copy', 'copies')}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="space-y-3" aria-labelledby="prompts-heading">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <div>
                <h3 id="prompts-heading" className="typography-ui-header font-semibold text-foreground">Prompts</h3>
                <p className="typography-meta text-muted-foreground">Human-submitted prompt text only. Agent output and attachment contents are never included.</p>
              </div>
              {filterNote ? <FilterBadge label={filterNote} /> : null}
            </div>
            <form
              className="grid gap-2 rounded-xl border border-border/60 bg-[var(--surface-subtle)]/25 p-3 md:grid-cols-[minmax(0,1fr)_12rem_12rem_auto]"
              onSubmit={(event) => { event.preventDefault(); setFilters(filterDraft); }}
            >
              <Input aria-label="Search Prompts" placeholder="Search prompt text…" value={filterDraft.search} onChange={(event) => setFilterDraft((current) => ({ ...current, search: event.target.value }))} />
              <Input aria-label="Filter by Agent" placeholder="Agent" value={filterDraft.agent} onChange={(event) => setFilterDraft((current) => ({ ...current, agent: event.target.value }))} />
              <Input aria-label="Filter by Model" placeholder="Provider or model" value={filterDraft.model} onChange={(event) => setFilterDraft((current) => ({ ...current, model: event.target.value }))} />
              <Button type="submit" variant="outline"><RiFileSearchLine className="h-4 w-4" /> Apply</Button>
            </form>
            {detailPending ? (
              <div className="flex min-h-28 items-center justify-center gap-2 rounded-xl border border-border/60 typography-meta text-muted-foreground">
                <RiLoader4Line className="h-4 w-4 animate-spin" /> Loading prompts…
              </div>
            ) : (
              <PromptList events={prompts} timeZone={timeZone} nextCursor={nextCursor} loadingMore={loadingMore} onLoadMore={() => void loadMore()} />
            )}
          </section>

          <section className="space-y-3" aria-labelledby="interactions-heading">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <div>
                <h3 id="interactions-heading" className="typography-ui-header font-semibold text-foreground">Changes & Interactions</h3>
                <p className="typography-meta text-muted-foreground">File opens, copies, and safe field-level account or settings changes.</p>
              </div>
              {filterNote ? <FilterBadge label={filterNote} /> : null}
            </div>
            {detailPending ? (
              <div className="flex min-h-28 items-center justify-center gap-2 rounded-xl border border-border/60 typography-meta text-muted-foreground">
                <RiLoader4Line className="h-4 w-4 animate-spin" /> Loading changes and interactions…
              </div>
            ) : interactionEvents.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border/70 px-4 py-8 text-center typography-meta text-muted-foreground">
                {dayFilterActive ? 'No changes or interactions on the selected day.' : 'No changes or interactions in this range.'}
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-border/60 bg-[var(--surface-elevated)]">
                {interactionEvents.map((event, index) => (
                  <div key={event.id} className={cn('grid gap-x-3 gap-y-1 px-3 py-3 transition-colors hover:bg-[var(--surface-subtle)]/40 md:grid-cols-[9.5rem_minmax(0,1fr)_auto] md:items-start', index > 0 && 'border-t border-border/45')}>
                    <div className="flex items-center gap-1.5 typography-micro text-muted-foreground">
                      <RiTimeLine className="h-3 w-3 shrink-0" />
                      <span className="font-medium text-foreground">{formatSessionDate(localDateOf(event.created_at, timeZone))}</span>
                      <span>{formatTime(event.created_at, timeZone)}</span>
                    </div>
                    <div className="min-w-0">
                      <div className="truncate typography-ui-label font-medium text-foreground">{actionLabel(event.action)}</div>
                      {event.action === 'clipboard.copied' ? (
                        <ClipboardInteractionDetails event={event} userId={user.id} />
                      ) : (
                        <div className="mt-0.5 typography-meta text-muted-foreground">{changeDetails(event)}</div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 md:justify-end">
                      <span className="truncate typography-micro font-medium text-foreground">{event.actor?.displayName || event.actor_role || 'System'}</span>
                      <StatusPill success={event.success} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      ) : (
        <div className="rounded-xl border border-dashed border-border/70 px-4 py-12 text-center typography-meta text-muted-foreground">No analytics are available.</div>
      )}
    </div>
  );
};
