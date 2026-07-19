export const CURSOR_ACP_PROVIDER_ID = 'cursor-acp';

export const isCursorProvider = (providerID: string | null | undefined): boolean => {
  return providerID === CURSOR_ACP_PROVIDER_ID;
};

export const shouldRenderAssistantCopyButton = ({
  hasCopyableText,
  onCopyMessageConfigured,
}: {
  hasCopyableText: boolean;
  onCopyMessageConfigured: boolean;
}): boolean => {
  return hasCopyableText && onCopyMessageConfigured;
};

export interface ShouldRenderStandaloneAssistantActionsInput {
  providerID?: string | null;
  shouldShowStandaloneMessageActions: boolean;
  messageId: string;
  groupStartIndex: number;
  groupEndIndex: number;
  lastRenderableTextPartIndex: number;
  textPartIds: readonly string[];
  text?: string;
  summarySourceMessageId?: string;
  summarySourcePartId?: string;
  hasToolAfterTextGroup?: boolean;
}

export const isAssistantStatusAnnouncementText = (text: string | undefined): boolean => {
  const normalized = typeof text === 'string'
    ? text.replace(/\s+/g, ' ').trim()
    : '';
  if (!normalized || normalized.length > 220) {
    return false;
  }

  const plain = normalized
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[`*_]/g, '');
  if (/^Loading Skill:\s+\S/i.test(plain)) {
    return true;
  }

  if (/^Waiting on (?:the )?dispatch status(?:[.!?…]+)?$/i.test(plain)) {
    return true;
  }

  if (/^I(?:'m| am)\s+using\s+the\s+[A-Za-z0-9 /:_-]{1,80}\s+skill\s+to\s+.+[.!?]?$/.test(plain)) {
    return true;
  }

  if (/^(?:I(?:'ll| will)\s+)?(?:check|checking|inspect|inspecting|review|reviewing|search|searching|read|reading|trace|tracing)\s+.+\s+via\s+@[a-z][a-z0-9_-]*[.!?]?$/i.test(plain)) {
    return true;
  }

  return /^Using\s+[A-Z][A-Za-z0-9 /:_-]{1,80}\s+(?:to|guidance because)\s+.+[.!?]?$/.test(plain);
};

export const shouldSuppressIntermediateAssistantStatusText = ({
  messageFinish,
  hasToolParts,
  text,
}: {
  messageFinish?: string;
  hasToolParts: boolean;
  text?: string;
}): boolean => {
  return messageFinish === 'tool-calls' && hasToolParts && isAssistantStatusAnnouncementText(text);
};

export const shouldRenderStandaloneAssistantActionsForTextGroup = ({
  providerID,
  shouldShowStandaloneMessageActions,
  messageId,
  groupStartIndex,
  groupEndIndex,
  lastRenderableTextPartIndex,
  textPartIds,
  text,
  summarySourceMessageId,
  summarySourcePartId,
  hasToolAfterTextGroup,
}: ShouldRenderStandaloneAssistantActionsInput): boolean => {
  if (!shouldShowStandaloneMessageActions) {
    return false;
  }

  if (isAssistantStatusAnnouncementText(text)) {
    return false;
  }

  if (!isCursorProvider(providerID)) {
    return lastRenderableTextPartIndex >= groupStartIndex && lastRenderableTextPartIndex <= groupEndIndex;
  }

  if (!summarySourceMessageId || !summarySourcePartId || summarySourceMessageId !== messageId) {
    return false;
  }

  if (hasToolAfterTextGroup) {
    return false;
  }

  return textPartIds.includes(summarySourcePartId);
};
