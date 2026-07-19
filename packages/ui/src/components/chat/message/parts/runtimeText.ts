export const coerceRuntimeText = (value: unknown, fallback = ''): string => {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value === null || value === undefined || typeof value === 'symbol' || typeof value === 'function') {
    return fallback;
  }
  if (value instanceof Error) {
    return value.message || fallback;
  }

  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? serialized : fallback;
  } catch {
    return fallback;
  }
};
