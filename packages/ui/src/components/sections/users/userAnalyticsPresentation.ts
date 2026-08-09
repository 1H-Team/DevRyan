import { formatAgentDisplayName } from '@/lib/agentDisplay';
import { formatEffortLabel } from '@/components/chat/mobileControlsUtils';

export const formatPromptModelLabel = (providerId: string, modelId: string): string => {
  if (providerId && modelId) return `${providerId}/${modelId}`;
  return modelId || 'Model unavailable';
};

export interface PromptRowSummary {
  title: string;
  preview: string | null;
}

// Collapsed rows use the first meaningful line as their title and reserve the
// remaining meaningful lines for a preview. The expanded prompt keeps the
// original text untouched, including its whitespace.
export const formatPromptRowSummary = (promptText: string): PromptRowSummary => {
  const lines = promptText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return { title: '(Attachment-only prompt)', preview: null };
  }

  const [title, ...previewLines] = lines;
  return {
    title,
    preview: previewLines.length > 0 ? previewLines.join(' ') : null,
  };
};

// "1 prompt" / "2 prompts" — irregular plurals pass an explicit form ("copy", "copies").
export const pluralize = (count: number, singular: string, plural = `${singular}s`): string => (
  `${count} ${count === 1 ? singular : plural}`
);

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
