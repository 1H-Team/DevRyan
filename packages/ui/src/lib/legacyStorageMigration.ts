/**
 * Browser storage keys are `devryan`-prefixed; keys written before the rename use
 * the accepted `openchamber` prefix. Each entry copies an old key to its new name
 * once, when the new key is still missing, before any store hydrates. Old keys
 * are kept so a downgraded or stale tab still reads its own state. IndexedDB
 * database names are storage identities and are not renamed.
 */
const LEGACY_KEY_PREFIX = /^openchamber(?=[._:-])/;

export const devRyanStorageKey = (legacyKey: string): string => legacyKey.replace(LEGACY_KEY_PREFIX, 'devryan');

/** Copies legacy keys in one storage area; returns how many were copied. */
export const migrateLegacyStorageKeys = (storage: Storage | null | undefined): number => {
  if (!storage) return 0;
  const legacyKeys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null && LEGACY_KEY_PREFIX.test(key)) legacyKeys.push(key);
  }
  let copied = 0;
  for (const key of legacyKeys) {
    const next = devRyanStorageKey(key);
    const value = storage.getItem(key);
    if (value === null || storage.getItem(next) !== null) continue;
    storage.setItem(next, value);
    copied += 1;
  }
  return copied;
};

/** Runs for localStorage and sessionStorage; unavailable storage is skipped. */
export const migrateLegacyBrowserStorage = (): void => {
  for (const area of ['localStorage', 'sessionStorage'] as const) {
    try { migrateLegacyStorageKeys(globalThis[area]); } catch { /* Storage disabled or full. */ }
  }
};
