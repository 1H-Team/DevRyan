// Visibility comes from typed provider records, never from the wording of an
// answer. Regex stripping cannot distinguish a quoted protocol example from
// actual reasoning, and used to delete legitimate headings and sentences.
export const isPublicBotAssistantTextPart = (part) => (
  part?.type === 'text'
  && typeof part.text === 'string'
  && part.synthetic !== true
  && part.ignored !== true
  && part.visible !== false
);

// Kept for encrypted historical messages that no longer carry provider parts.
// New messages cross the typed, final-record boundary before persistence.
export const sanitizeBotConversationalText = (value) => (
  typeof value === 'string' ? value : ''
);

export const sanitizeBotConversationalTextParts = (parts) => (
  (Array.isArray(parts) ? parts : [])
    .filter(isPublicBotAssistantTextPart)
    .map((part) => part.text)
    .join('')
);
