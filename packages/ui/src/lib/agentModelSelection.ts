export type AgentModelSelection = {
  providerId: string;
  modelId: string;
  variant?: string;
};

export const parseAgentModelSelections = (value: unknown): Record<string, AgentModelSelection> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;

  const selections: Record<string, AgentModelSelection> = {};
  for (const [agentName, selection] of Object.entries(value as Record<string, unknown>)) {
    const name = agentName.trim();
    const entry = selection as { providerId?: unknown; modelId?: unknown; variant?: unknown } | null;
    if (!name || !entry || typeof entry.providerId !== 'string' || typeof entry.modelId !== 'string') continue;

    const providerId = entry.providerId.trim();
    const modelId = entry.modelId.trim();
    if (!providerId || !modelId) continue;

    const variant = typeof entry.variant === 'string' ? entry.variant.trim() : '';
    selections[name] = {
      providerId,
      modelId,
      ...(variant ? { variant } : {}),
    };
  }

  return selections;
};
