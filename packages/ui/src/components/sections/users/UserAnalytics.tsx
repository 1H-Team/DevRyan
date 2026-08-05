import * as React from 'react';
import {
  RiBrainLine,
  RiFileList2Line,
  RiFileSearchLine,
  RiFlashlightLine,
  RiGitBranchLine,
  RiLoader4Line,
  RiRefreshLine,
  RiRobot2Line,
  RiTimeLine,
} from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  requestJson,
  selectClassName,
  type ActivityRow,
  type UserAnalyticsEvent,
  type UserAnalyticsEventsPage,
  type UserAnalyticsRange,
  type UserRow,
} from './types';
import { ActivityList } from './ActivitySection';
import {
  formatMinutes,
  formatPromptAgentLabel,
  formatPromptModelLabel,
  formatPromptThinkingLabel,
} from './userAnalyticsPresentation';
import { MetricTrendChart } from './MetricTrendChart';

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

const StatCard: React.FC<{ label: string; value: string | number; qualifier?: string }> = ({ label, value, qualifier }) => (
  <div className="rounded-xl border border-border/60 bg-[var(--surface-elevated)] px-3 py-3">
    <div className="typography-micro uppercase tracking-wide text-muted-foreground">{label}</div>
    <div className="mt-1 typography-ui-header font-semibold text-foreground">{value}</div>
    {qualifier ? <div className="typography-micro text-muted-foreground">{qualifier}</div> : null}
  </div>
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

const PromptList: React.FC<{
  events: UserAnalyticsEvent[];
  timeZone: string;
  nextCursor: string | null;
  loadingMore: boolean;
  onLoadMore: () => void;
}> = ({ events, timeZone, nextCursor, loadingMore, onLoadMore }) => (
  <div className="space-y-2">
    {events.length === 0 ? (
      <div className="rounded-xl border border-dashed border-border/70 px-4 py-8 text-center typography-meta text-muted-foreground">
        No prompts match this range and filter set.
      </div>
    ) : events.map((event) => {
      const provider = metadataString(event, 'providerId');
      const model = metadataString(event, 'modelId');
      const modelLabel = formatPromptModelLabel(provider, model);
      const thinkingLabel = formatPromptThinkingLabel(metadataString(event, 'variant'), provider);
      const agentLabel = formatPromptAgentLabel(metadataString(event, 'agent'));
      const projectName = metadataString(event, 'projectName') || 'Unknown project';
      const branchName = metadataString(event, 'branchName') || 'unknown branch';
      const promptText = metadataString(event, 'promptText');
      return (
        <details key={event.id} className="group rounded-xl border border-border/60 bg-[var(--surface-elevated)] open:bg-[var(--surface-subtle)]/30">
          <summary className="cursor-pointer list-none px-3 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate typography-ui-label font-medium text-foreground">
                  {promptText || '(Attachment-only prompt)'}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <MetaPill icon={<RiTimeLine className="h-3 w-3" />} tip="Sent at">{formatTime(event.created_at, timeZone)}</MetaPill>
                  <MetaPill icon={<RiRobot2Line className="h-3 w-3" />} tip="Agent">{agentLabel}</MetaPill>
                  <MetaPill icon={<RiBrainLine className="h-3 w-3" />} tip="Model">{modelLabel}</MetaPill>
                  <MetaPill icon={<RiFlashlightLine className="h-3 w-3" />} tip="Thinking level">{thinkingLabel}</MetaPill>
                  <MetaPill icon={<RiGitBranchLine className="h-3 w-3" />} tip="Repository / branch">{projectName} / {branchName}</MetaPill>
                </div>
              </div>
              <span className="shrink-0 typography-micro text-muted-foreground group-open:hidden">Expand</span>
            </div>
          </summary>
          <div className="border-t border-border/50 px-3 py-3">
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words typography-code text-foreground">{promptText || '(No text parts)'}</pre>
            {event.metadata?.promptTruncated === true ? (
              <p className="mt-2 typography-micro text-[var(--status-warning)]">
                Truncated at 16 KiB; original length {metadataNumber(event, 'promptOriginalLength').toLocaleString()} characters.
              </p>
            ) : null}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <MetaPill icon={<RiBrainLine className="h-3 w-3" />} tip="Model">{modelLabel}</MetaPill>
              <MetaPill icon={<RiFlashlightLine className="h-3 w-3" />} tip="Thinking level">{thinkingLabel}</MetaPill>
              <MetaPill icon={<RiFileList2Line className="h-3 w-3" />} tip="Attachments (count only)">{metadataNumber(event, 'attachmentCount')} attachments</MetaPill>
            </div>
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
  const [rangeData, setRangeData] = React.useState<UserAnalyticsRange | null>(null);
  const [prompts, setPrompts] = React.useState<UserAnalyticsEvent[]>([]);
  const [interactions, setInteractions] = React.useState<UserAnalyticsEvent[]>([]);
  const [changes, setChanges] = React.useState<UserAnalyticsEvent[]>([]);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = React.useState(0);
  const [filterDraft, setFilterDraft] = React.useState({ search: '', agent: '', model: '' });
  const [filters, setFilters] = React.useState(filterDraft);
  const zones = React.useMemo(timeZones, []);

  const baseQuery = React.useMemo(() => (
    new URLSearchParams({ start: range.start, end: range.end, timeZone })
  ), [range.start, range.end, timeZone]);

  const activePreset = range.end === localDate(timeZone) ? spanDays(range.start, range.end) : 0;

  const promptUrl = React.useCallback((cursor?: string | null) => {
    const params = new URLSearchParams(baseQuery);
    params.set('category', 'prompts');
    params.set('limit', '50');
    if (filters.search) params.set('search', filters.search);
    if (filters.agent) params.set('agent', filters.agent);
    if (filters.model) params.set('model', filters.model);
    if (cursor) params.set('cursor', cursor);
    return `/api/admin/users/${encodeURIComponent(user.id)}/analytics/events?${params}`;
  }, [baseQuery, filters, user.id]);

  React.useEffect(() => {
    if (!active || !canViewDetailed) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const rangeUrl = `/api/admin/users/${encodeURIComponent(user.id)}/analytics/range?${baseQuery}`;
    const eventUrl = (category: 'interactions' | 'changes') => {
      const params = new URLSearchParams(baseQuery);
      params.set('category', category);
      params.set('limit', '100');
      return `/api/admin/users/${encodeURIComponent(user.id)}/analytics/events?${params}`;
    };
    void Promise.all([
      requestJson<UserAnalyticsRange>(rangeUrl, { signal: controller.signal }),
      requestJson<UserAnalyticsEventsPage>(promptUrl(), { signal: controller.signal }),
      requestJson<UserAnalyticsEventsPage>(eventUrl('interactions'), { signal: controller.signal }),
      requestJson<UserAnalyticsEventsPage>(eventUrl('changes'), { signal: controller.signal }),
    ]).then(([nextRange, promptPage, interactionPage, changePage]) => {
      setRangeData(nextRange);
      setPrompts(promptPage.events);
      setNextCursor(promptPage.nextCursor);
      setInteractions(interactionPage.events);
      setChanges(changePage.events);
    }).catch((caught) => {
      if (controller.signal.aborted) return;
      setError(caught instanceof Error ? caught.message : 'Analytics could not be loaded');
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [active, baseQuery, canViewDetailed, promptUrl, reloadNonce, user.id]);

  const updateTimeZone = (value: string) => {
    setTimeZone(value);
    try { window.localStorage.setItem(TIME_ZONE_STORAGE_KEY, value); } catch { /* Local preference only. */ }
  };

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await requestJson<UserAnalyticsEventsPage>(promptUrl(nextCursor));
      setPrompts((current) => [...current, ...page.events]);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'More prompts could not be loaded');
    } finally {
      setLoadingMore(false);
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
  const rangeQualifier = rangeData ? `over ${rangeData.days} day${rangeData.days === 1 ? '' : 's'}` : undefined;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-[var(--surface-subtle)]/25 p-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 typography-micro text-muted-foreground">
            <span>From</span>
            <Input type="date" value={range.start} max={range.end} onChange={(event) => setRange((current) => clampRange(event.target.value, current.end))} className="w-40" />
          </label>
          <label className="flex flex-col gap-1 typography-micro text-muted-foreground">
            <span>To</span>
            <Input type="date" value={range.end} min={range.start} onChange={(event) => setRange((current) => clampRange(current.start, event.target.value))} className="w-40" />
          </label>
          <div className="flex items-center gap-1">
            {RANGE_PRESETS.map((days) => (
              <Button
                key={days}
                variant={activePreset === days ? 'default' : 'outline'}
                size="sm"
                aria-label={`Last ${days} days`}
                onClick={() => setRange(presetRange(timeZone, days))}
              >
                {`${days}d`}
              </Button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <label className="flex flex-col gap-1 typography-micro text-muted-foreground">
            <span>Time Zone</span>
            <select aria-label="Analytics Time Zone" className={cn(selectClassName, 'w-full sm:w-64')} value={timeZone} onChange={(event) => updateTimeZone(event.target.value)}>
              {!zones.includes(timeZone) ? <option value={timeZone}>{timeZone}</option> : null}
              {zones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
            </select>
          </label>
          <Button variant="outline" onClick={() => setReloadNonce((value) => value + 1)} disabled={loading}>
            <RiRefreshLine className={cn('h-4 w-4', loading && 'animate-spin')} /> Refresh
          </Button>
        </div>
      </div>

      {error ? (
        <div role="alert" className="rounded-xl border border-[var(--status-error)]/35 bg-[var(--status-error)]/10 px-4 py-3 typography-meta text-foreground">
          <div className="font-medium">Analytics could not be loaded</div>
          <div className="mt-1 text-muted-foreground">{error}</div>
        </div>
      ) : null}

      {loading && !rangeData ? (
        <div className="flex min-h-64 items-center justify-center gap-2 typography-meta text-muted-foreground">
          <RiLoader4Line className="h-4 w-4 animate-spin" /> Loading analytics…
        </div>
      ) : rangeData ? (
        <>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
            <StatCard label="Estimated active" value={formatMinutes(rangeData.totals.estimatedActiveMinutes)} qualifier={rangeQualifier} />
            <StatCard label="Prompts sent" value={rangeData.totals.prompts} qualifier={rangeQualifier} />
            <StatCard label="Files opened" value={rangeData.totals.filesOpened} qualifier={rangeQualifier} />
            <StatCard label="Copies" value={rangeData.totals.copies} qualifier={rangeQualifier} />
            <StatCard label="Settings changes" value={rangeData.totals.settingsChanges} qualifier={rangeQualifier} />
          </div>

          <section className="space-y-2" aria-labelledby="activity-graph-heading">
            <div className="flex items-baseline justify-between gap-3">
              <div>
                <h3 id="activity-graph-heading" className="typography-ui-header font-semibold text-foreground">Activity graph</h3>
                <p className="typography-meta text-muted-foreground">Daily totals across the selected range. Toggle metrics on or off; hover for exact values.</p>
              </div>
              <span className="shrink-0 typography-micro text-muted-foreground">{rangeData.days}-day range</span>
            </div>
            <MetricTrendChart series={rangeData.series} />
          </section>

          <section className="space-y-3" aria-labelledby="activity-sessions-heading">
            <div>
              <h3 id="activity-sessions-heading" className="typography-ui-header font-semibold text-foreground">Activity sessions</h3>
              <p className="typography-meta text-muted-foreground">Estimated work blocks split after gaps greater than 30 minutes, with a five-minute tail.</p>
            </div>
            {rangeData.activitySessions.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border/70 px-4 py-8 text-center typography-meta text-muted-foreground">No direct activity in this range.</div>
            ) : (
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {rangeData.activitySessions.map((session) => (
                  <div key={session.id + session.date} className="rounded-xl border border-border/60 bg-[var(--surface-elevated)] px-3 py-3">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="typography-ui-label font-medium text-foreground">{formatTime(session.start, timeZone)}–{formatTime(session.end, timeZone)}</span>
                      <span className="typography-meta font-semibold text-foreground">≈ {formatMinutes(session.estimatedMinutes)}</span>
                    </div>
                    <div className="mt-0.5 typography-micro text-muted-foreground">{formatSessionDate(session.date)}</div>
                    <p className="mt-1 typography-micro text-muted-foreground">
                      {session.actionCount} actions · {session.counts.prompts} prompts · {session.counts.filesOpened} files · {session.counts.copies} copies
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="space-y-3" aria-labelledby="prompts-heading">
            <div>
              <h3 id="prompts-heading" className="typography-ui-header font-semibold text-foreground">Prompts</h3>
              <p className="typography-meta text-muted-foreground">Human-submitted prompt text only. Agent output and attachment contents are never included.</p>
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
            <PromptList events={prompts} timeZone={timeZone} nextCursor={nextCursor} loadingMore={loadingMore} onLoadMore={() => void loadMore()} />
          </section>

          <section className="space-y-3" aria-labelledby="interactions-heading">
            <div>
              <h3 id="interactions-heading" className="typography-ui-header font-semibold text-foreground">Changes & interactions</h3>
              <p className="typography-meta text-muted-foreground">File opens, copies, and safe field-level account or settings changes.</p>
            </div>
            {interactionEvents.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border/70 px-4 py-8 text-center typography-meta text-muted-foreground">No changes or interactions in this range.</div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-border/60 bg-[var(--surface-elevated)]">
                {interactionEvents.map((event, index) => (
                  <div key={event.id} className={cn('grid gap-2 px-3 py-3.5 md:grid-cols-[12rem_minmax(0,1fr)_auto] md:items-start', index > 0 && 'border-t border-border/45')}>
                    <div className="min-w-0">
                      <div className="truncate typography-ui-label font-medium text-foreground">{actionLabel(event.action)}</div>
                      <div className="mt-0.5 flex items-center gap-1 typography-micro text-muted-foreground">
                        <RiTimeLine className="h-3 w-3" />{formatTime(event.created_at, timeZone)}
                      </div>
                    </div>
                    <div className="min-w-0 typography-meta text-foreground">{changeDetails(event)}</div>
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
