export type SubmitInterruptOptions = {
  currentSessionId?: string | null
  sessionPhase: "idle" | string
  queuedMessageCount: number
  queuedOnly: boolean
  isSubtaskSession?: boolean
}

export function isAbortableSessionPhase(sessionPhase: "idle" | string): boolean {
  return sessionPhase !== "idle" && sessionPhase !== "question"
}

export function shouldInterruptBeforeSubmit(options: SubmitInterruptOptions): boolean {
  if (options.isSubtaskSession) {
    return false
  }

  if (!options.currentSessionId || !isAbortableSessionPhase(options.sessionPhase)) {
    return false
  }

  if (options.queuedOnly) {
    return options.queuedMessageCount > 0
  }

  return true
}
