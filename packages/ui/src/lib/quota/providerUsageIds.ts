import type { QuotaProviderId } from '@/types';

import { QUOTA_PROVIDER_MAP, type QuotaProviderMeta } from './providers';

/**
 * Catalog provider ids whose usage is reported under a different quota id.
 * Mirrors the server's quota `providerAliases` and each quota provider's
 * auth-key aliases (packages/web/server/lib/quota/providers/).
 */
const CATALOG_TO_QUOTA_PROVIDER_ID: Readonly<Record<string, QuotaProviderId>> = {
  anthropic: 'claude',
  'anthropic-oauth': 'claude',
  'opencode-with-claude': 'claude',
  openai: 'codex',
  chatgpt: 'codex',
  cursor: 'cursor-acp',
  grok: 'xai',
  'xai-oauth': 'xai',
  zen: 'opencode',
  'opencode-zen': 'opencode',
  zai: 'zai-coding-plan',
  'z.ai': 'zai-coding-plan',
  zhipuai: 'zhipuai-coding-plan',
  zhipu: 'zhipuai-coding-plan',
  kimi: 'kimi-for-coding',
  nanogpt: 'nano-gpt',
  nano_gpt: 'nano-gpt',
  copilot: 'github-copilot',
};

/** The quota id that reports usage for a Providers-catalog id, or null when none does. */
export const getQuotaProviderIdForProvider = (providerId: string | null | undefined): QuotaProviderId | null => {
  const normalized = (providerId ?? '').trim().toLowerCase();
  if (!normalized) return null;
  const aliased = CATALOG_TO_QUOTA_PROVIDER_ID[normalized];
  if (aliased) return aliased;
  return QUOTA_PROVIDER_MAP[normalized]?.id ?? null;
};

/**
 * Usage sources with no matching Providers row, for example Claude usage via a
 * proxy without an Anthropic provider, or Zen usage via device sign-in.
 */
export const getUsageOnlyQuotaProviders = (
  visibleQuotaProviders: readonly QuotaProviderMeta[],
  catalogProviderIds: Iterable<string>,
): QuotaProviderMeta[] => {
  const covered = new Set<QuotaProviderId>();
  for (const providerId of catalogProviderIds) {
    const quotaProviderId = getQuotaProviderIdForProvider(providerId);
    if (quotaProviderId) covered.add(quotaProviderId);
  }
  return visibleQuotaProviders.filter((provider) => !covered.has(provider.id));
};

/** Settings Providers selection for a usage-only row (`useConfigStore.selectedProviderId`). */
export const USAGE_ONLY_PROVIDER_SELECTION_PREFIX = '__usage__:';

export const toUsageOnlyProviderSelection = (quotaProviderId: QuotaProviderId): string => (
  `${USAGE_ONLY_PROVIDER_SELECTION_PREFIX}${quotaProviderId}`
);

export const parseUsageOnlyProviderSelection = (selection: string | null | undefined): QuotaProviderId | null => {
  if (!selection?.startsWith(USAGE_ONLY_PROVIDER_SELECTION_PREFIX)) return null;
  const quotaProviderId = selection.slice(USAGE_ONLY_PROVIDER_SELECTION_PREFIX.length);
  return QUOTA_PROVIDER_MAP[quotaProviderId]?.id ?? null;
};
