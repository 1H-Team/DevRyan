const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Translated native configuration owns the budget; saved legacy data is only
 * a fallback for snapshots produced before native compaction translation. */
export function nativeCompactionReserve(location) {
  const native = object(location?.configuration?.compaction) ? location.configuration.compaction.buffer : undefined;
  const legacy = object(location?.compatibility?.legacy?.compaction) ? location.compatibility.legacy.compaction.reserved : undefined;
  const value = native === undefined ? legacy : native;
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
