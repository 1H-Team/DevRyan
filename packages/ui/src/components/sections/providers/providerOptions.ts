import { CURSOR_ACP_PROVIDER_ID } from '@/lib/providers/cursorAcp';
import { isAnthropicOAuthProviderId } from '@/lib/providers/display';

export interface ProviderOption {
  id: string;
  name?: string;
}

const ANTHROPIC_PROVIDER_OPTION: ProviderOption = { id: 'anthropic', name: 'Claude' };
const ANTIGRAVITY_PROVIDER_OPTION: ProviderOption = { id: 'antigravity', name: 'Antigravity' };
const CURSOR_ACP_PROVIDER_OPTION: ProviderOption = { id: CURSOR_ACP_PROVIDER_ID, name: 'Cursor' };
const GITHUB_COPILOT_PROVIDER_OPTION: ProviderOption = { id: 'github-copilot', name: 'GitHub Copilot' };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const normalizeAvailableProviderName = (provider: ProviderOption): ProviderOption => (
  isAnthropicOAuthProviderId(provider.id) ? { ...provider, name: 'Claude' } : provider
);

const normalizeProviderOption = (provider: ProviderOption): ProviderOption => {
  if (provider.id === 'copilot' || provider.id === GITHUB_COPILOT_PROVIDER_OPTION.id) {
    return GITHUB_COPILOT_PROVIDER_OPTION;
  }
  return normalizeAvailableProviderName(provider);
};

const normalizeProviderEntry = (entry: unknown): ProviderOption | null => {
  if (typeof entry === 'string') {
    return { id: entry };
  }
  if (!isRecord(entry)) {
    return null;
  }
  const idCandidate =
    (typeof entry.id === 'string' && entry.id) ||
    (typeof entry.providerID === 'string' && entry.providerID) ||
    (typeof entry.slug === 'string' && entry.slug) ||
    (typeof entry.name === 'string' && entry.name);
  if (!idCandidate) {
    return null;
  }
  const nameCandidate = typeof entry.name === 'string' ? entry.name : undefined;
  return { id: idCandidate, name: nameCandidate };
};

export const parseProvidersPayload = (payload: unknown): ProviderOption[] => {
  let entries: unknown[] = [];

  if (Array.isArray(payload)) {
    entries = payload;
  } else if (isRecord(payload)) {
    if (Array.isArray(payload.all)) {
      entries = payload.all;
    } else if (Array.isArray(payload.providers)) {
      entries = payload.providers;
    }
  }

  const mapped = entries
    .map((entry) => normalizeProviderEntry(entry))
    .filter((entry): entry is ProviderOption => Boolean(entry));

  for (const provider of [
    ANTHROPIC_PROVIDER_OPTION,
    ANTIGRAVITY_PROVIDER_OPTION,
    CURSOR_ACP_PROVIDER_OPTION,
    GITHUB_COPILOT_PROVIDER_OPTION,
  ]) {
    if (!mapped.some((entry) => entry.id === provider.id)) {
      mapped.push(provider);
    }
  }

  const normalized = mapped.map(normalizeProviderOption);
  const seen = new Set<string>();
  return normalized.filter((entry) => {
    if (seen.has(entry.id)) {
      return false;
    }
    seen.add(entry.id);
    return true;
  });
};
