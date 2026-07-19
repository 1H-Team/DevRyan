const CACHE_SIZE_UNITS = ['B', 'KB', 'MB', 'GB'] as const;

export const formatCacheSize = (sizeBytes: number): string => {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return '0 B';
  }

  const unitIndex = Math.min(
    Math.floor(Math.log(sizeBytes) / Math.log(1024)),
    CACHE_SIZE_UNITS.length - 1,
  );
  const value = sizeBytes / (1024 ** unitIndex);
  const formattedValue = unitIndex === 0 ? Math.floor(value).toString() : value.toFixed(1);
  return `${formattedValue} ${CACHE_SIZE_UNITS[unitIndex]}`;
};
