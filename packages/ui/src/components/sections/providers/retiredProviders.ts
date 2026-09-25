import type { Provider } from '@opencode-ai/sdk/v2';

// Antigravity (opencode-antigravity-auth) is retired and no longer offered as a
// provider. Its entry exists only so leftover account files or plugin-written
// config can still be disconnected; the source-driven visibility filter hides
// it whenever nothing is left to remove.
const RETIRED_PROVIDER_IDS = new Set(['antigravity']);

type RetiredProviderEntry = Omit<Provider, 'models'> & { models: never[] };

const RETIRED_PROVIDER_ENTRIES: readonly RetiredProviderEntry[] = [
  { id: 'antigravity', name: 'Antigravity', source: 'custom', env: [], options: {}, models: [] },
];

export const isRetiredProviderId = (providerId: string | null | undefined): boolean => (
  RETIRED_PROVIDER_IDS.has(providerId?.trim().toLowerCase() ?? '')
);

export const withRetiredProviderEntries = <TProvider extends { id: string }>(
  providers: TProvider[],
): Array<TProvider | RetiredProviderEntry> => {
  const missing = RETIRED_PROVIDER_ENTRIES.filter((entry) => (
    !providers.some((provider) => provider.id === entry.id)
  ));
  return missing.length > 0 ? [...providers, ...missing] : providers;
};
