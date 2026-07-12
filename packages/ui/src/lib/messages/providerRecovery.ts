import type { Message } from '@opencode-ai/sdk/v2/client';

import type { ProviderRecoveryInput } from '@/stores/useProviderRecoveryStore';

const clean = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() ? value.trim() : null
);

export function buildProviderRecoveryInput(input: {
  sessionId: string;
  directory: string;
  reason: string;
  messages: Message[];
  now?: number;
}): ProviderRecoveryInput | null {
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index] as Message & {
      agent?: unknown;
      variant?: unknown;
      model?: { providerID?: unknown; modelID?: unknown; variant?: unknown };
    };
    if (message.role !== 'user') continue;
    const providerId = clean(message.model?.providerID);
    const modelId = clean(message.model?.modelID);
    if (!providerId || !modelId) return null;
    return {
      sessionId: input.sessionId,
      directory: input.directory,
      anchorUserMessageId: message.id,
      reason: clean(input.reason) ?? 'The model provider could not continue',
      providerId,
      modelId,
      variant: clean(message.model?.variant ?? message.variant),
      agent: clean(message.agent),
      createdAt: input.now ?? Date.now(),
    };
  }
  return null;
}
