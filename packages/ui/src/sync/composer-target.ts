export type ComposerTarget =
  | { kind: "session"; id: string }
  | { kind: "draft"; id: string }
  | { kind: "none" }

export const resolveComposerTarget = (
  sessionId: string | null | undefined,
  draftId: string | null | undefined,
): ComposerTarget => {
  if (sessionId) return { kind: "session", id: sessionId }
  if (draftId) return { kind: "draft", id: draftId }
  return { kind: "none" }
}

export const getComposerTargetKey = (target: ComposerTarget): string => {
  if (target.kind === "none") return "none"
  return `${target.kind}:${target.id}`
}

export const getSessionComposerTargetKey = (sessionId: string): string =>
  getComposerTargetKey({ kind: "session", id: sessionId })

export const getDraftComposerTargetKey = (draftId: string): string =>
  getComposerTargetKey({ kind: "draft", id: draftId })

export const isPersistableComposerTargetKey = (targetKey: string | null | undefined): targetKey is string =>
  Boolean(targetKey && targetKey !== "none" && /^(?:session|draft):.+/.test(targetKey))
