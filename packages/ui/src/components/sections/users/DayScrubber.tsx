import * as React from 'react';

import { cn } from '@/lib/utils';
import { formatMinutes, pluralize } from './userAnalyticsPresentation';
import type { UserAnalyticsRangeDay } from './types';

const BAR_TRACK = 44;
const BAR_MIN = 6;

const formatDayShort = (date: string): string => new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric',
}).format(new Date(`${date}T12:00:00`));

const formatDayLong = (date: string): string => new Intl.DateTimeFormat(undefined, {
  weekday: 'short', month: 'short', day: 'numeric',
}).format(new Date(`${date}T12:00:00`));

interface DayScrubberProps {
  series: UserAnalyticsRangeDay[];
  selectedDate: string | null;
  onSelect: (date: string) => void;
  sessionCountByDate: Map<string, number>;
}

// The chart's day-selection control: a thin magnitude rail rendered directly beneath
// the trend graph, in the same chronological (oldest → newest) order as the chart's
// x-axis. One day may be selected at a time; empty days stay visible as short dimmed
// ticks so the timeline reads continuously. Selection state lives in UserAnalytics.
export const DayScrubber: React.FC<DayScrubberProps> = ({
  series,
  selectedDate,
  onSelect,
  sessionCountByDate,
}) => {
  if (series.length === 0) return null;
  const maxMinutes = Math.max(1, ...series.map((day) => day.estimatedActiveMinutes));
  // Label a subset (like the chart's x-axis) so dense ranges don't crowd; selected
  // days are always labelled.
  const stride = Math.max(1, Math.ceil(series.length / 8));

  return (
    <div
      role="group"
      aria-label="Filter by Day"
      className="flex items-end gap-0.5 rounded-xl border border-border/60 bg-[var(--surface-subtle)]/35 px-2 pb-1.5 pt-2"
    >
      {series.map((day, index) => {
        const selected = selectedDate === day.date;
        const idle = day.estimatedActiveMinutes === 0 && day.prompts === 0;
        const barHeight = idle
          ? 2
          : Math.max(BAR_MIN, Math.round((day.estimatedActiveMinutes / maxMinutes) * BAR_TRACK));
        const showLabel = selected || index % stride === 0 || index === series.length - 1;
        const sessions = sessionCountByDate.get(day.date) ?? 0;
        const summary = `${formatDayLong(day.date)} · ${formatMinutes(day.estimatedActiveMinutes)} · ${pluralize(day.prompts, 'prompt')}`
          + (sessions ? ` · ${pluralize(sessions, 'session')}` : '');
        return (
          <button
            key={day.date}
            type="button"
            onClick={() => onSelect(day.date)}
            aria-pressed={selected}
            aria-label={summary}
            title={summary}
            className={cn(
              'group flex min-w-0 flex-1 flex-col items-center gap-1 rounded-md px-0.5 pb-0.5 pt-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
              selected ? 'bg-[color-mix(in_srgb,var(--primary-base)_12%,transparent)]' : 'hover:bg-interactive-hover',
            )}
          >
            <span className="flex w-full items-end justify-center" style={{ height: BAR_TRACK }}>
              <span
                className={cn(
                  'w-2 rounded-full transition-colors',
                  selected
                    ? 'bg-[var(--primary-base)]'
                    : idle
                      ? 'bg-border'
                      : 'bg-[color-mix(in_srgb,var(--foreground)_32%,transparent)] group-hover:bg-[color-mix(in_srgb,var(--foreground)_52%,transparent)]',
                )}
                style={{ height: `${barHeight}px` }}
              />
            </span>
            <span
              className={cn(
                'h-3.5 w-full truncate text-center typography-micro leading-none',
                selected ? 'font-semibold text-[var(--primary-base)]' : 'text-muted-foreground',
                !showLabel && 'opacity-0',
              )}
            >
              {formatDayShort(day.date)}
            </span>
          </button>
        );
      })}
    </div>
  );
};
