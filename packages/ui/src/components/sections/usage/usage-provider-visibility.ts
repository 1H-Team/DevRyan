import { getSortedQuotaProviders } from '@/lib/quota';
import type { ProviderResult } from '@/types';

export const getVisibleUsageProviders = (
  results: Pick<ProviderResult, 'providerId' | 'configured'>[],
) => {
  const configuredByProviderId = new Map(results.map((entry) => [entry.providerId, entry.configured]));
  return getSortedQuotaProviders().filter((provider) => (
    configuredByProviderId.get(provider.id) === true
    || (provider.id === 'cursor-acp' && configuredByProviderId.has(provider.id))
  ));
};
