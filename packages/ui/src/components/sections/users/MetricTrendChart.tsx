import * as React from 'react';

import { cn } from '@/lib/utils';
import { formatMinutes } from './userAnalyticsPresentation';
import { resolveMetricTrendHover } from './metricTrendState';

export interface MetricTrendPoint {
  date: string;
  estimatedActiveMinutes: number;
  prompts: number;
  filesOpened: number;
  copies: number;
  settingsChanges: number;
}

type MetricKey = keyof Omit<MetricTrendPoint, 'date'>;
type Axis = 'left' | 'right';

interface MetricConfig {
  key: MetricKey;
  label: string;
  color: string;
  axis: Axis;
  format: (value: number) => string;
}

const METRICS: MetricConfig[] = [
  { key: 'prompts', label: 'Prompts', color: 'var(--chart-2)', axis: 'left', format: (v) => String(v) },
  { key: 'estimatedActiveMinutes', label: 'Active time', color: 'var(--chart-1)', axis: 'right', format: formatMinutes },
  { key: 'filesOpened', label: 'Files opened', color: 'var(--chart-3)', axis: 'left', format: (v) => String(v) },
  { key: 'copies', label: 'Copies', color: 'var(--chart-4)', axis: 'left', format: (v) => String(v) },
  { key: 'settingsChanges', label: 'Settings changes', color: 'var(--chart-5)', axis: 'left', format: (v) => String(v) },
];

const DEFAULT_ENABLED: MetricKey[] = ['prompts', 'estimatedActiveMinutes'];

const VIEW_W = 820;
const VIEW_H = 260;
const PAD_L = 40;
const PAD_R = 46;
const PAD_T = 16;
const PAD_B = 30;
const PLOT_W = VIEW_W - PAD_L - PAD_R;
const PLOT_H = VIEW_H - PAD_T - PAD_B;

const niceMax = (value: number): number => {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
};

const formatDayLabel = (date: string): string => new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric',
}).format(new Date(`${date}T12:00:00`));

const formatDayLong = (date: string): string => new Intl.DateTimeFormat(undefined, {
  weekday: 'short', month: 'short', day: 'numeric',
}).format(new Date(`${date}T12:00:00`));

const xAt = (index: number, count: number): number => (
  count <= 1 ? PAD_L + PLOT_W / 2 : PAD_L + (index / (count - 1)) * PLOT_W
);

export const MetricTrendChart: React.FC<{
  series: MetricTrendPoint[];
  selectedDate?: string | null;
}> = ({ series, selectedDate = null }) => {
  const [enabled, setEnabled] = React.useState<Set<MetricKey>>(() => new Set(DEFAULT_ENABLED));
  const [hoveredDate, setHoveredDate] = React.useState<string | null>(null);
  const containerRef = React.useRef<HTMLDivElement | null>(null);

  const visibleMetrics = METRICS.filter((metric) => enabled.has(metric.key));
  const leftMetrics = visibleMetrics.filter((metric) => metric.axis === 'left');
  const rightMetrics = visibleMetrics.filter((metric) => metric.axis === 'right');

  const leftMax = niceMax(Math.max(1, ...series.flatMap((point) => leftMetrics.map((metric) => point[metric.key]))));
  const rightMax = niceMax(Math.max(1, ...series.flatMap((point) => rightMetrics.map((metric) => point[metric.key]))));

  const yAt = (value: number, axis: Axis): number => {
    const max = axis === 'right' ? rightMax : leftMax;
    return PAD_T + PLOT_H - (value / max) * PLOT_H;
  };

  // The selected day is highlighted without changing the full-range trend line.
  const selectedIndex = selectedDate
    ? series.findIndex((point) => point.date === selectedDate)
    : -1;
  const hover = resolveMetricTrendHover(series, hoveredDate);
  const bandHalf = Math.min((series.length > 1 ? PLOT_W / (series.length - 1) : PLOT_W) * 0.5, 22);

  const toggle = (key: MetricKey) => setEnabled((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const handleMove = (clientX: number) => {
    const container = containerRef.current;
    if (!container || series.length === 0) return;
    const rect = container.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    const plotStart = PAD_L / VIEW_W;
    const plotEnd = (VIEW_W - PAD_R) / VIEW_W;
    const t = Math.min(1, Math.max(0, (ratio - plotStart) / (plotEnd - plotStart)));
    const index = Math.round(t * (series.length - 1));
    setHoveredDate(series[index]?.date ?? null);
  };

  const yTicks = [0, 0.25, 0.5, 0.75, 1];
  const summary = series.length === 0
    ? 'No activity in the selected range.'
    : `${visibleMetrics.map((metric) => metric.label).join(', ') || 'No metrics'} across ${series.length} day${series.length === 1 ? '' : 's'}.`;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {METRICS.map((metric) => {
          const active = enabled.has(metric.key);
          return (
            <button
              key={metric.key}
              type="button"
              onClick={() => toggle(metric.key)}
              aria-pressed={active}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 typography-micro font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]',
                active
                  ? 'border-border/70 bg-[var(--surface-elevated)] text-foreground'
                  : 'border-border/40 bg-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: active ? metric.color : 'transparent', border: `1.5px solid ${metric.color}` }}
              />
              {metric.label}
            </button>
          );
        })}
      </div>

      {series.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/70 px-4 py-12 text-center typography-meta text-muted-foreground">
          No activity in the selected range.
        </div>
      ) : (
        <div className="rounded-xl border border-border/60 bg-[var(--surface-subtle)]/35 p-2">
          <div
            ref={containerRef}
            className="relative"
            onMouseMove={(event) => handleMove(event.clientX)}
            onMouseLeave={() => setHoveredDate(null)}
            onTouchMove={(event) => handleMove(event.touches[0]?.clientX ?? 0)}
            onTouchEnd={() => setHoveredDate(null)}
          >
          <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="h-auto w-full" role="img" aria-label={summary}>
            {/* Horizontal gridlines + left-axis (count) labels */}
            {yTicks.map((tick) => {
              const y = PAD_T + PLOT_H - tick * PLOT_H;
              return (
                <g key={`grid-${tick}`}>
                  <line x1={PAD_L} y1={y} x2={VIEW_W - PAD_R} y2={y} stroke="var(--border)" strokeOpacity={0.4} strokeWidth={1} />
                  {leftMetrics.length > 0 ? (
                    <text x={PAD_L - 6} y={y + 3} textAnchor="end" className="fill-[var(--muted-foreground)] [font-size:10px]">
                      {Math.round(tick * leftMax)}
                    </text>
                  ) : null}
                  {rightMetrics.length > 0 ? (
                    <text x={VIEW_W - PAD_R + 6} y={y + 3} textAnchor="start" className="fill-[var(--muted-foreground)] [font-size:10px]">
                      {Math.round(tick * rightMax)}
                    </text>
                  ) : null}
                </g>
              );
            })}

            {/* Selected-day highlight bands (behind the metric lines) */}
            {selectedIndex >= 0 ? (() => {
              const cx = xAt(selectedIndex, series.length);
              const x1 = Math.max(PAD_L, cx - bandHalf);
              const x2 = Math.min(VIEW_W - PAD_R, cx + bandHalf);
              return (
                <g key={`sel-band-${series[selectedIndex].date}`}>
                  <rect x={x1} y={PAD_T} width={x2 - x1} height={PLOT_H} fill="var(--primary-base)" opacity={0.1} />
                  <line x1={cx} y1={PAD_T} x2={cx} y2={PAD_T + PLOT_H} stroke="var(--primary-base)" strokeOpacity={0.5} strokeWidth={1} strokeDasharray="3 3" />
                </g>
              );
            })() : null}

            {/* Hover guide */}
            {hover ? (
              <line
                x1={xAt(hover.index, series.length)} y1={PAD_T}
                x2={xAt(hover.index, series.length)} y2={PAD_T + PLOT_H}
                stroke="var(--foreground)" strokeOpacity={0.25} strokeWidth={1}
              />
            ) : null}

            {/* Metric lines */}
            {visibleMetrics.map((metric) => {
              const points = series.map((point, index) => `${xAt(index, series.length)},${yAt(point[metric.key], metric.axis)}`).join(' ');
              return (
                <polyline
                  key={metric.key}
                  points={points}
                  fill="none"
                  stroke={metric.color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}

            {/* Persistent markers on selected days */}
            {selectedIndex >= 0 ? visibleMetrics.map((metric) => (
              <circle
                key={`sel-dot-${metric.key}-${series[selectedIndex].date}`}
                cx={xAt(selectedIndex, series.length)}
                cy={yAt(series[selectedIndex][metric.key], metric.axis)}
                r={3.5}
                fill={metric.color}
                stroke="var(--surface-elevated)"
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
              />
            )) : null}

            {/* Hover point markers */}
            {hover ? visibleMetrics.map((metric) => (
              <circle
                key={`dot-${metric.key}`}
                cx={xAt(hover.index, series.length)}
                cy={yAt(hover.point[metric.key], metric.axis)}
                r={3.5}
                fill="var(--surface-elevated)"
                stroke={metric.color}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            )) : null}

            {/* X-axis date labels (subset to avoid crowding; selected days always shown) */}
            {series.map((point, index) => {
              const stride = Math.max(1, Math.ceil(series.length / 6));
              const isSelected = selectedDate === point.date;
              if (!isSelected && index % stride !== 0 && index !== series.length - 1) return null;
              return (
                <text
                  key={`x-${point.date}`}
                  x={xAt(index, series.length)}
                  y={VIEW_H - 10}
                  textAnchor="middle"
                  className={cn('[font-size:10px]', isSelected ? 'fill-[var(--primary-base)] font-semibold' : 'fill-[var(--muted-foreground)]')}
                >
                  {formatDayLabel(point.date)}
                </text>
              );
            })}
          </svg>

          {/* Tooltip */}
          {hover && visibleMetrics.length > 0 ? (
            <div
              className="pointer-events-none absolute top-2 z-10 min-w-36 -translate-x-1/2 rounded-lg border border-border/70 bg-[var(--surface-elevated)] px-2.5 py-2 shadow-md"
              style={{
                left: `${Math.min(
                  Math.max((xAt(hover.index, series.length) / VIEW_W) * (containerRef.current?.clientWidth ?? VIEW_W), 74),
                  (containerRef.current?.clientWidth ?? VIEW_W) - 74,
                )}px`,
              }}
            >
              <div className="typography-micro font-semibold text-foreground">{formatDayLong(hover.point.date)}</div>
              <div className="mt-1 space-y-0.5">
                {visibleMetrics.map((metric) => (
                  <div key={metric.key} className="flex items-center justify-between gap-3 typography-micro text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: metric.color }} />
                      {metric.label}
                    </span>
                    <span className="font-medium text-foreground">{metric.format(hover.point[metric.key])}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* Screen-reader data table */}
          <table className="sr-only">
            <caption>{summary}</caption>
            <thead>
              <tr>
                <th>Day</th>
                {visibleMetrics.map((metric) => <th key={metric.key}>{metric.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {series.map((point) => (
                <tr key={point.date}>
                  <th scope="row">{formatDayLong(point.date)}</th>
                  {visibleMetrics.map((metric) => <td key={metric.key}>{metric.format(point[metric.key])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </div>
  );
};
