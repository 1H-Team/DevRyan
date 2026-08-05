import { formatAgentDisplayName } from '@/lib/agentDisplay';
import { formatEffortLabel } from '@/components/chat/mobileControlsUtils';

export const formatPromptModelLabel = (providerId: string, modelId: string): string => {
  if (providerId && modelId) return `${providerId}/${modelId}`;
  return modelId || 'Model unavailable';
};

export const formatMinutes = (minutes: number): string => {
  const rounded = Math.max(0, Math.round(minutes));
  if (rounded < 60) return `${rounded}m`;
  const hours = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
};

// Turns a raw agent id (e.g. "orchestrator", "code_reviewer") into a titled label
// ("Orchestrator", "Code Reviewer"). Falls back to "Default Agent" when absent.
export const formatPromptAgentLabel = (agent: string): string => {
  const trimmed = (agent || '').trim();
  return trimmed ? formatAgentDisplayName(trimmed) : 'Default Agent';
};

// Turns a raw thinking `variant` id into a readable effort label ("High", "Extra High",
// "Light", …) using the shared chat formatter; provider context selects "Light" vs "Low".
export const formatPromptThinkingLabel = (variant: string, providerId: string): string => (
  formatEffortLabel(variant, { providerId: providerId || undefined })
);
