export type DurationDisplay =
  | { available: true; label: string; milliseconds: number }
  | { available: false; label: 'Unavailable'; milliseconds: null };

const unavailableDuration = (): DurationDisplay => ({
  available: false,
  label: 'Unavailable',
  milliseconds: null,
});

export const formatDurationMilliseconds = (
  milliseconds: number,
  options: { final?: boolean } = {},
): DurationDisplay => {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return unavailableDuration();
  }

  const normalized = options.final && milliseconds > 0 && milliseconds < 100
    ? 100
    : milliseconds;

  if (normalized < 60_000) {
    return {
      available: true,
      label: `${(normalized / 1_000).toFixed(1)}s`,
      milliseconds,
    };
  }

  const totalSeconds = Math.floor(normalized / 1_000);
  if (normalized < 60 * 60_000) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return {
      available: true,
      label: `${minutes}m ${seconds}s`,
      milliseconds,
    };
  }

  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return {
    available: true,
    label: `${hours}h ${minutes}m ${seconds}s`,
    milliseconds,
  };
};

export const formatElapsedDuration = (
  start: number,
  end: number | undefined,
  now: number = Date.now(),
): DurationDisplay => {
  if (!Number.isFinite(start)) return unavailableDuration();
  const effectiveEnd = end ?? now;
  if (!Number.isFinite(effectiveEnd) || effectiveEnd < start) return unavailableDuration();
  return formatDurationMilliseconds(effectiveEnd - start, { final: end !== undefined });
};
