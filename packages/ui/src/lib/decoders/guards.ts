// Shared guards for decoding server payloads. Arrays are never records, so a
// decoder that expects an object refuses `[]` instead of reading its keys.

export type UnknownRecord = Record<string, unknown>;

export const isRecord = (value: unknown): value is UnknownRecord => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

/** The first candidate that is a non-empty string after trimming, trimmed; '' otherwise. */
export const readTrimmedString = (...candidates: unknown[]): string => {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
};

/** The first candidate that is a non-empty string, as is; undefined otherwise. */
export const readNonEmptyString = (...candidates: unknown[]): string | undefined => {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  return undefined;
};

export const readString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';
export const isOptionalNullableString = (value: unknown): value is string | null | undefined => (
  value === undefined || isNullableString(value)
);
export const isTimestamp = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0
);
export const isNullableTimestamp = (value: unknown): value is number | null => value === null || isTimestamp(value);
export const isOptionalNullableTimestamp = (value: unknown): value is number | null | undefined => (
  value === undefined || isNullableTimestamp(value)
);
export const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** A guard for membership in a fixed set of string literals. */
export const oneOf = <T extends string>(values: readonly T[]) => {
  const allowed: ReadonlySet<string> = new Set(values);
  return (value: unknown): value is T => typeof value === 'string' && allowed.has(value);
};
