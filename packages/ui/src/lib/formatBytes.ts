const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB'] as const;

export const formatBytes = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const unitIndex = Math.min(
    Math.floor(Math.log(value) / Math.log(1024)),
    BYTE_UNITS.length - 1,
  );
  const scaled = value / (1024 ** unitIndex);
  return unitIndex === 0
    ? `${Math.floor(scaled)} B`
    : `${scaled.toFixed(1)} ${BYTE_UNITS[unitIndex]}`;
};
