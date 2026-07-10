export const CURSOR_SESSION_TITLE_MAX_LENGTH = 80;

const trimString = (value) => (typeof value === 'string' ? value.trim() : '');

export const buildCursorSessionTitlePrompt = (text) => [
  'Generate a concise title for this coding session.',
  'Return only the title: 3 to 7 words, sentence case, no markdown, no quotes, and no trailing punctuation.',
  `Keep it under ${CURSOR_SESSION_TITLE_MAX_LENGTH} characters and summarize the intent instead of repeating the full prompt.`,
  'Do not use tools or inspect the workspace.',
  '',
  '<user_prompt>',
  trimString(text),
  '</user_prompt>',
].join('\n');

export const normalizeCursorSessionTitle = (value) => {
  const line = String(value || '')
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry && !/^```/.test(entry));
  if (!line) return null;

  const normalized = line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^[`*_~"'“”‘’]+|[`*_~"'“”‘’]+$/g, '')
    .replace(/[.!?;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return null;
  if (normalized.length <= CURSOR_SESSION_TITLE_MAX_LENGTH) return normalized;
  return `${normalized.slice(0, CURSOR_SESSION_TITLE_MAX_LENGTH - 3).trimEnd()}...`;
};

export const generateCursorSessionTitle = async ({ Agent, apiKey, text, directory }) => {
  const promptText = trimString(text);
  if (!promptText || !trimString(apiKey) || typeof Agent?.prompt !== 'function') return null;
  const normalizedDirectory = trimString(directory);
  const result = await Agent.prompt(buildCursorSessionTitlePrompt(promptText), {
    apiKey: trimString(apiKey),
    model: { id: 'auto' },
    local: {
      ...(normalizedDirectory ? { cwd: normalizedDirectory } : {}),
      settingSources: [],
    },
    ...(normalizedDirectory ? { platform: { workspaceRef: normalizedDirectory } } : {}),
  });
  return normalizeCursorSessionTitle(result?.result);
};
