import { create } from "zustand"
import { z } from "zod"

const identity = z.string().min(1).max(512)
const presentationEnvelope = z.object({
  presentationEpoch: identity,
  presentationRevision: z.number().int().nonnegative().safe(),
  presentation: z.object({
    provider: z.enum(["native", "cursor"]),
    phase: z.literal("finalizing"),
    generation: identity,
    objectiveID: identity,
    assistantID: identity,
    stepID: identity.nullable(),
    attemptID: identity.nullable(),
    progress: z.number().int().nonnegative().safe(),
  }).refine(value => value.provider === "cursor" || Boolean(value.stepID && value.attemptID)).nullable(),
})

export type SessionPresentationEnvelope = z.infer<typeof presentationEnvelope>
type PresentationRecord = SessionPresentationEnvelope | null
const MAX_DIRECTORY_PRESENTATIONS = 256
const boundSessions = (sessions: Record<string, PresentationRecord>, keep: string) => {
  const ids = Object.keys(sessions)
  while (ids.length > MAX_DIRECTORY_PRESENTATIONS) {
    const index = ids.findIndex(id => id !== keep && !sessions[id]?.presentation)
    const [id] = ids.splice(index < 0 ? 0 : index, 1)
    delete sessions[id]
  }
  return sessions
}
type SessionPresentationStore = {
  directories: Record<string, Record<string, PresentationRecord>>
  accept(directory: string, sessionID: string, value: unknown, snapshot?: { baseline: PresentationRecord | undefined }): void
  clear(directory: string, sessionID: string, snapshot?: { baseline: PresentationRecord | undefined }): void
  removeSession(directory: string, sessionID: string): void
  clearDirectory(directory: string): void
}

// Only loaded directory/session lifecycles own these entries; no persistence or activity authority.
export const useSessionPresentationStore = create<SessionPresentationStore>()((set) => ({
  directories: {},
  accept(directory, sessionID, value, snapshot) {
    const parsed = presentationEnvelope.safeParse(value)
    if (!parsed.success) return
    set((state) => {
      const previous = state.directories[directory]?.[sessionID]
      if (snapshot && previous !== snapshot.baseline) return state
      if (previous) {
        if (previous.presentationEpoch === parsed.data.presentationEpoch) {
          if (previous.presentationRevision >= parsed.data.presentationRevision) return state
        } else if (!snapshot) return state
      }
      return { directories: { ...state.directories, [directory]: boundSessions({
        ...state.directories[directory], [sessionID]: parsed.data,
      }, sessionID) } }
    })
  },
  clear(directory, sessionID, snapshot) {
    set((state) => {
      const previous = state.directories[directory]?.[sessionID]
      if (snapshot && previous !== snapshot.baseline) return state
      if (previous === null || previous?.presentation === null) return state
      return { directories: { ...state.directories, [directory]: boundSessions({
        ...state.directories[directory],
        [sessionID]: previous ? { ...previous, presentation: null } : null,
      }, sessionID) } }
    })
  },
  removeSession(directory, sessionID) {
    set((state) => {
      const previous = state.directories[directory]
      if (!previous || !Object.hasOwn(previous, sessionID)) return state
      const sessions = { ...previous }
      delete sessions[sessionID]
      return { directories: { ...state.directories, [directory]: sessions } }
    })
  },
  clearDirectory(directory) {
    set((state) => {
      if (!state.directories[directory]) return state
      const directories = { ...state.directories }
      delete directories[directory]
      return { directories }
    })
  },
}))

export function isAssistantFinalizing(
  envelope: PresentationRecord | undefined,
  status: string | undefined,
  currentPromptID: string | undefined,
): boolean {
  return status === "busy"
    && Boolean(currentPromptID && envelope?.presentation?.objectiveID === currentPromptID)
}

export async function hydrateSessionPresentations(input: {
  directory: string
  baseURL: string
  sessionIDs: Iterable<string>
  isCurrent: (sessionID: string) => boolean
  isBusy: (sessionID: string) => boolean
  signal?: AbortSignal
}): Promise<void> {
  const store = useSessionPresentationStore.getState()
  const baseline = store.directories[input.directory]
  const sessions = [...input.sessionIDs]
  if (!sessions.length) return
  try {
    const response = await fetch(`${input.baseURL.replace(/\/+$/, "")}/session-activity`, {
      cache: "no-store",
      credentials: "include",
      signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    })
    if (!response.ok) return
    const value: unknown = await response.json()
    if (!value || typeof value !== "object" || Array.isArray(value) || input.signal?.aborted) return
    for (const sessionID of sessions) {
      if (!input.isCurrent(sessionID)) continue
      const entry = Object.hasOwn(value, sessionID) ? Reflect.get(value, sessionID) : undefined
      const expected = { baseline: baseline?.[sessionID] }
      if (!input.isBusy(sessionID) || !presentationEnvelope.safeParse(entry).success) {
        store.clear(input.directory, sessionID, expected)
      } else {
        store.accept(input.directory, sessionID, entry, expected)
      }
    }
  } catch {
    // Presentation is optional; normal session status remains authoritative.
  }
}
