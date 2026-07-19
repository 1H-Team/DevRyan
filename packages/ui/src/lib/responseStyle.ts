import type { Part } from '@opencode-ai/sdk/v2';

export const RESPONSE_STYLE_LEVELS = ['provider', 'actions', 'concise', 'detailed'] as const;
export type ResponseStyleLevel = typeof RESPONSE_STYLE_LEVELS[number];
export type ResponseStylePreset = Exclude<ResponseStyleLevel, 'provider'>;

const LEGACY_CONCISE_PRESETS = new Set(['concise', 'noFiller', 'matchEnergy']);
const LEGACY_DETAILED_PRESETS = new Set(['detailed', 'mentor', 'pushback', 'warmPeer']);
const RESPONSE_STYLE_MARKER_PATTERN = /<system-reminder\s+data-devryan-response-style="(actions|concise|detailed)">/;

export const isResponseStyleLevel = (value: unknown): value is ResponseStyleLevel => (
  typeof value === 'string' && RESPONSE_STYLE_LEVELS.includes(value as ResponseStyleLevel)
);

export const isResponseStylePreset = (value: unknown): value is ResponseStylePreset => (
  value === 'actions' || value === 'concise' || value === 'detailed'
);

export const resolveResponseStyleLevel = (settings: unknown): ResponseStyleLevel => {
  const candidate = settings as {
    responseStyleEnabled?: unknown;
    responseStylePreset?: unknown;
  } | null | undefined;

  if (candidate?.responseStyleEnabled !== true) return 'provider';
  if (candidate.responseStylePreset === 'actions') return 'actions';
  if (LEGACY_DETAILED_PRESETS.has(String(candidate.responseStylePreset))) return 'detailed';
  if (LEGACY_CONCISE_PRESETS.has(String(candidate.responseStylePreset))) return 'concise';

  // Removed custom and unknown presets cannot be mapped safely to a rationale
  // depth, so preserve provider behavior until the user selects a level.
  return 'provider';
};

export const getResponseStylePresetInstructions = (preset: ResponseStylePreset): string => {
  switch (preset) {
    case 'actions':
      return 'Show only a short action or status summary for each major step. Do not add a separate rationale. Write every visible summary as a complete, punctuated sentence.';
    case 'concise':
      return 'For each major step, include one concise user-facing sentence that explains why it is the right next action. Do not expose private chain-of-thought. Write every visible summary as a complete, punctuated sentence.';
    case 'detailed':
      return 'For each major step, provide a short user-facing paragraph summarizing the evidence, rationale, and relevant tradeoffs before taking action. Do not expose private chain-of-thought. Write every visible summary as complete, punctuated prose.';
  }
};

export const buildResponseStyleInstruction = ({
  enabled,
  preset,
}: {
  enabled?: boolean;
  preset?: unknown;
  customInstructions?: unknown;
}): string | null => {
  const level = resolveResponseStyleLevel({ responseStyleEnabled: enabled, responseStylePreset: preset });
  return level === 'provider' ? null : getResponseStylePresetInstructions(level);
};

export const wrapResponseStyleReminder = (
  level: ResponseStyleLevel,
  instruction: string,
): string => {
  if (level === 'provider' || !instruction.trim()) return '';
  return `<system-reminder data-devryan-response-style="${level}">\n${instruction.trim()}\n</system-reminder>`;
};

export const readResponseStyleLevelFromParts = (parts: Part[]): ResponseStyleLevel => {
  for (const part of parts) {
    const candidate = part as { type?: unknown; text?: unknown; synthetic?: unknown };
    if (candidate.type !== 'text' || candidate.synthetic !== true || typeof candidate.text !== 'string') {
      continue;
    }
    const match = RESPONSE_STYLE_MARKER_PATTERN.exec(candidate.text);
    if (match && isResponseStylePreset(match[1])) return match[1];
  }
  return 'provider';
};

export const readSessionResponseStyleLevel = (
  messages: readonly { parts: Part[] }[],
): ResponseStyleLevel => {
  for (const message of messages) {
    const level = readResponseStyleLevelFromParts(message.parts);
    if (level !== 'provider') return level;
  }
  return 'provider';
};

export const shouldAttachResponseStyleReminder = ({
  isNewSessionDraft,
  hasExistingSession,
  existingSessionHasUserMessages,
}: {
  isNewSessionDraft: boolean;
  hasExistingSession: boolean;
  existingSessionHasUserMessages: boolean;
}): boolean => isNewSessionDraft || (hasExistingSession && !existingSessionHasUserMessages);

type ResponseStyleSettings = {
  responseStyleEnabled?: unknown;
  responseStylePreset?: unknown;
  responseStyleCustomInstructions?: unknown;
};

let cachedResponseStyleInstruction: string | null = null;
let cachedResponseStyleLevel: ResponseStyleLevel = 'provider';
let responseStyleInstructionLoaded = false;

export const cacheResponseStyleInstructionFromSettings = (settings: unknown): string | null => {
  const payload = settings as ResponseStyleSettings | null | undefined;
  cachedResponseStyleLevel = resolveResponseStyleLevel(payload);
  cachedResponseStyleInstruction = cachedResponseStyleLevel === 'provider'
    ? null
    : getResponseStylePresetInstructions(cachedResponseStyleLevel);
  responseStyleInstructionLoaded = true;
  return cachedResponseStyleInstruction;
};

export const getCachedResponseStyleInstruction = (): string | null => cachedResponseStyleInstruction;

export const getCachedResponseStyleLevel = (): ResponseStyleLevel => cachedResponseStyleLevel;

export const isResponseStyleInstructionLoaded = (): boolean => responseStyleInstructionLoaded;

export const clearResponseStyleInstructionCacheForTests = (): void => {
  cachedResponseStyleInstruction = null;
  cachedResponseStyleLevel = 'provider';
  responseStyleInstructionLoaded = false;
};

export const fetchResponseStyleInstruction = async (): Promise<string | null> => {
  const response = await fetch('/api/config/settings', {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) return null;
  const settings = await response.json().catch(() => null) as ResponseStyleSettings | null;
  return cacheResponseStyleInstructionFromSettings(settings);
};
