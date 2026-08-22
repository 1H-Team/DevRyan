import type { QuotaProviderId } from '@/types';

export interface QuotaProviderMeta {
  id: QuotaProviderId;
  name: string;
}

export const QUOTA_PROVIDERS: QuotaProviderMeta[] = [
  { id: 'claude', name: 'Claude' },
  { id: 'codex', name: 'ChatGPT' },
  { id: 'xai', name: 'xAI' },
  { id: 'opencode', name: 'OpenCode Zen' },
  { id: 'opencode-go', name: 'OpenCode Go' },
  { id: 'cursor-acp', name: 'Cursor' },
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'github-copilot', name: 'GitHub Copilot' },
  { id: 'google', name: 'Google' },
  { id: 'antigravity', name: 'Antigravity' },
  { id: 'kimi-for-coding', name: 'Kimi for Coding' },
  { id: 'nano-gpt', name: 'NanoGPT' },
  { id: 'openrouter', name: 'OpenRouter' },
  { id: 'zai-coding-plan', name: 'z.ai' },
  { id: 'zhipuai-coding-plan', name: 'Zhipu AI Coding Plan' },
  { id: 'minimax-cn-coding-plan', name: 'MiniMax Coding Plan (minimaxi.com)' },
  { id: 'minimax-coding-plan', name: 'MiniMax Coding Plan (minimax.io)' },
  { id: 'ollama-cloud', name: 'Ollama Cloud' },
];

const providerNameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

export const getSortedQuotaProviders = (): QuotaProviderMeta[] => (
  [...QUOTA_PROVIDERS].sort((left, right) => (
    providerNameCollator.compare(left.name, right.name)
    || left.id.localeCompare(right.id)
  ))
);

export const QUOTA_PROVIDER_MAP = QUOTA_PROVIDERS.reduce<
  Record<string, QuotaProviderMeta>
>((acc, provider) => {
  acc[provider.id] = provider;
  return acc;
}, {});
