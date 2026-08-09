export interface MetricTrendHover<T> {
  index: number;
  point: T;
}

export const resolveMetricTrendHover = <T extends { date: string }>(
  series: T[],
  hoveredDate: string | null,
): MetricTrendHover<T> | null => {
  if (!hoveredDate) return null;
  const index = series.findIndex((point) => point.date === hoveredDate);
  if (index < 0) return null;
  return { index, point: series[index] };
};
