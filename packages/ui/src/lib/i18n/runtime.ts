import { getSafeStorage } from '@/stores/utils/safeStorage';
export type Locale = 'en';

export const LOCALES = ['en'] as const satisfies readonly Locale[];

export const DEFAULT_LOCALE: Locale = 'en';

export const LOCALE_LABEL_KEYS: Record<Locale, 'common.language.english'> = {
  en: 'common.language.english',
};

export const LOCALE_STORAGE_KEY = 'openchamber.i18n.v1';

type StoredLocale = {
  locale?: unknown;
};

export function normalizeLocale(value: string | undefined | null): Locale {
  void value;
  // English is the only supported locale; stale persisted non-English values
  // from older releases are intentionally normalized back to English.
  return DEFAULT_LOCALE;
}

export function readStoredLocale(): Locale | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  try {
    const raw = getSafeStorage().getItem(LOCALE_STORAGE_KEY);
    if (!raw) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as StoredLocale;
    return typeof parsed.locale === 'string' ? normalizeLocale(parsed.locale) : undefined;
  } catch {
    return undefined;
  }
}

export function writeStoredLocale(locale: Locale): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    getSafeStorage().setItem(LOCALE_STORAGE_KEY, JSON.stringify({ locale }));
  } catch {
    return;
  }
}

export function detectInitialLocale(): Locale {
  const stored = readStoredLocale();
  if (stored) {
    return stored;
  }

  return DEFAULT_LOCALE;
}
