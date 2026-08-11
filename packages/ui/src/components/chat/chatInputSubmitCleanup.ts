type ComposerTextarea = Pick<HTMLTextAreaElement, "value">

export type ClearCommittedComposerTextOptions = {
  attachedFilesCount: number
  textarea: ComposerTextarea | null
  clearPendingInputText: () => void
  clearPendingDraftPersist: () => void
  clearDraftTarget: () => void
  syncMessageRef: (value: string) => void
  setMessage: (value: string) => void
  clearAttachedFiles: () => void
}

export type ClearSubmittedComposerOptions = {
  queuedOnly: boolean
  textarea: ComposerTextarea | null
  clearPendingInputText: () => void
  clearPendingDraftPersist: () => void
  setMessage: (value: string) => void
  clearConfirmedMentions: () => void
  clearDraftTarget: () => void
  setHistoryIndex: (value: number) => void
  setDraftMessage: (value: string) => void
  setExpandedInput: (value: boolean) => void
}

export const mergeSubmittedAttachmentsForRecovery = <T extends { id: string }>(
  submitted: readonly T[],
  current: readonly T[],
): T[] => {
  const merged: T[] = []
  const seen = new Set<string>()

  for (const attachment of [...submitted, ...current]) {
    if (seen.has(attachment.id)) continue
    seen.add(attachment.id)
    merged.push(attachment)
  }

  return merged
}

export const clearCommittedComposerText = (options: ClearCommittedComposerTextOptions): void => {
  options.clearPendingInputText()
  options.clearPendingDraftPersist()
  options.clearDraftTarget()
  // Keep the imperative ref ahead of React state so unmount/draft persistence
  // cannot re-save a reverted prompt after the send has already committed.
  options.syncMessageRef("")
  options.setMessage("")

  if (options.textarea) {
    options.textarea.value = ""
  }

  if (options.attachedFilesCount > 0) {
    options.clearAttachedFiles()
  }
}

export const clearSubmittedComposerAfterSend = (options: ClearSubmittedComposerOptions): void => {
  if (options.queuedOnly) {
    return
  }

  options.clearPendingInputText()
  options.clearPendingDraftPersist()
  options.setMessage("")

  if (options.textarea) {
    options.textarea.value = ""
  }

  options.clearConfirmedMentions()
  options.clearDraftTarget()
  options.setHistoryIndex(-1)
  options.setDraftMessage("")

  options.setExpandedInput(false)
}
