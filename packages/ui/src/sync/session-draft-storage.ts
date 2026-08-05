import { getSafeStorage } from "@/stores/utils/safeStorage"
import type { ChatDraft } from "./session-ui-store"

export const CHAT_DRAFTS_STORAGE_KEY = "openchamber_chat_drafts"
export const LEGACY_NEW_INPUT_DRAFT_KEY = "openchamber_chat_input_draft_new"

const normalizePath = (value?: unknown): string | null => {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const replaced = trimmed.replace(/\\/g, "/")
  if (replaced === "/") return "/"
  return replaced.length > 1 ? replaced.replace(/\/+$/, "") : replaced
}

const normalizeOptionalString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const normalizeDraftSendConfig = (value: unknown): ChatDraft["sendConfig"] | undefined => {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  const sendConfig: NonNullable<ChatDraft["sendConfig"]> = {}
  const providerID = normalizeOptionalString(record.providerID)
  const modelID = normalizeOptionalString(record.modelID)
  const agent = normalizeOptionalString(record.agent)
  const variant = normalizeOptionalString(record.variant)
  const modelProvenance = record.modelProvenance === "explicit" || record.modelProvenance === "agent-default"
    ? record.modelProvenance
    : undefined

  if (providerID) sendConfig.providerID = providerID
  if (modelID) sendConfig.modelID = modelID
  if (agent) sendConfig.agent = agent
  if (variant) sendConfig.variant = variant
  if (typeof record.planMode === "boolean") sendConfig.planMode = record.planMode
  if (modelProvenance) sendConfig.modelProvenance = modelProvenance

  return Object.keys(sendConfig).length > 0 ? sendConfig : undefined
}

export const getDraftInputStorageKey = (draftId: string): string =>
  `openchamber_chat_input_draft_draft_${draftId}`

export const getDraftConfirmedMentionsStorageKey = (draftId: string): string =>
  `openchamber_chat_confirmed_mentions_draft_${draftId}`

export const getSessionInputStorageKey = (sessionId: string): string =>
  `openchamber_chat_input_draft_${sessionId}`

export const getSessionConfirmedMentionsStorageKey = (sessionId: string): string =>
  `openchamber_chat_confirmed_mentions_${sessionId}`

type PersistedSessionInputRemovalListener = (sessionId: string) => void

const persistedSessionInputRemovalListeners = new Set<PersistedSessionInputRemovalListener>()

export const subscribePersistedSessionInputRemoval = (
  listener: PersistedSessionInputRemovalListener,
): (() => void) => {
  persistedSessionInputRemovalListeners.add(listener)
  return () => {
    persistedSessionInputRemovalListeners.delete(listener)
  }
}

export const removePersistedSessionInput = (
  sessionId: string,
  storage: Storage = getSafeStorage(),
): void => {
  const normalizedSessionId = sessionId.trim()
  if (!normalizedSessionId) return

  for (const key of [
    getSessionInputStorageKey(normalizedSessionId),
    getSessionConfirmedMentionsStorageKey(normalizedSessionId),
  ]) {
    try {
      storage.removeItem(key)
    } catch {
      // Continue so one failed key removal cannot suppress the other cleanup.
    }
  }

  for (const listener of Array.from(persistedSessionInputRemovalListeners)) {
    try {
      listener(normalizedSessionId)
    } catch {
      // Storage cleanup remains authoritative even if a mounted consumer fails.
    }
  }
}

export const clearLegacyNewDraftInput = (storage: Storage = getSafeStorage()): void => {
  try {
    storage.removeItem(LEGACY_NEW_INPUT_DRAFT_KEY)
  } catch {
    // Ignore storage errors.
  }
}

export const removePersistedDraftInput = (storage: Storage = getSafeStorage(), draftId: string): void => {
  try {
    storage.removeItem(getDraftInputStorageKey(draftId))
    storage.removeItem(getDraftConfirmedMentionsStorageKey(draftId))
  } catch {
    // Ignore storage errors.
  }
}

export const createDraftId = (): string =>
  `draft_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`

const serializeDraft = (draft: ChatDraft): ChatDraft => ({
  ...draft,
  text: draft.text ?? "",
  directoryOverride: normalizePath(draft.directoryOverride ?? null),
  bootstrapPendingDirectory: normalizePath(draft.bootstrapPendingDirectory ?? null),
  sendConfig: normalizeDraftSendConfig(draft.sendConfig),
})

const parseCanonicalDrafts = (raw: string): { draftsById: Record<string, ChatDraft>; draftOrder: string[] } => {
  const parsed = JSON.parse(raw) as { drafts?: unknown; order?: unknown }
  const entries = Array.isArray(parsed?.drafts) ? parsed.drafts : []
  const draftsById: Record<string, ChatDraft> = {}
  const fallbackOrder: string[] = []

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue
    const record = entry as Partial<ChatDraft>
    if (typeof record.id !== "string" || record.id.length === 0) continue
    const createdAt = typeof record.createdAt === "number" ? record.createdAt : Date.now()
    const updatedAt = typeof record.updatedAt === "number" ? record.updatedAt : createdAt
    draftsById[record.id] = serializeDraft({
      id: record.id,
      text: typeof record.text === "string" ? record.text : "",
      createdAt,
      updatedAt,
      selectedProjectId: typeof record.selectedProjectId === "string" ? record.selectedProjectId : null,
      directoryOverride: normalizePath(record.directoryOverride ?? null),
      pendingWorktreeRequestId: typeof record.pendingWorktreeRequestId === "string" ? record.pendingWorktreeRequestId : null,
      bootstrapPendingDirectory: normalizePath(record.bootstrapPendingDirectory ?? null),
      preserveDirectoryOverride: record.preserveDirectoryOverride === true,
      targetBranchName: typeof record.targetBranchName === "string" ? record.targetBranchName : null,
      targetPreparationError: typeof record.targetPreparationError === "string" ? record.targetPreparationError : null,
      parentID: typeof record.parentID === "string" ? record.parentID : null,
      title: typeof record.title === "string" ? record.title : undefined,
      initialPrompt: typeof record.initialPrompt === "string" ? record.initialPrompt : undefined,
      syntheticParts: Array.isArray(record.syntheticParts) ? record.syntheticParts : undefined,
      planMode: record.planMode === true,
      sendConfig: normalizeDraftSendConfig(record.sendConfig),
      targetFolderId: typeof record.targetFolderId === "string" ? record.targetFolderId : undefined,
    })
    fallbackOrder.push(record.id)
  }

  const draftOrder = (Array.isArray(parsed?.order) ? parsed.order : fallbackOrder)
    .filter((id): id is string => typeof id === "string" && Boolean(draftsById[id]))
  for (const id of fallbackOrder) {
    if (!draftOrder.includes(id)) draftOrder.push(id)
  }

  return { draftsById, draftOrder }
}

export const persistDrafts = (
  storage: Storage = getSafeStorage(),
  draftsById: Record<string, ChatDraft>,
  draftOrder: string[],
): void => {
  try {
    const drafts = draftOrder
      .map((id) => draftsById[id])
      .filter((draft): draft is ChatDraft => Boolean(draft) && (draft.text.trim().length > 0 || !!normalizeDraftSendConfig(draft.sendConfig)))
      .map(serializeDraft)
    if (drafts.length === 0) {
      storage.removeItem(CHAT_DRAFTS_STORAGE_KEY)
      return
    }
    storage.setItem(CHAT_DRAFTS_STORAGE_KEY, JSON.stringify({ order: drafts.map((draft) => draft.id), drafts }))
  } catch {
    // Ignore storage errors.
  }
}

export const readPersistedDrafts = (
  storage: Storage = getSafeStorage(),
): { draftsById: Record<string, ChatDraft>; draftOrder: string[] } => {
  try {
    const raw = storage.getItem(CHAT_DRAFTS_STORAGE_KEY)
    const legacyText = storage.getItem(LEGACY_NEW_INPUT_DRAFT_KEY) ?? ""
    clearLegacyNewDraftInput(storage)

    if (raw) {
      return parseCanonicalDrafts(raw)
    }

    if (!legacyText.trim()) return { draftsById: {}, draftOrder: [] }

    const now = Date.now()
    const legacyDraft: ChatDraft = {
      id: createDraftId(),
      text: legacyText,
      createdAt: now,
      updatedAt: now,
      selectedProjectId: null,
      directoryOverride: null,
      parentID: null,
    }
    const draftsById = { [legacyDraft.id]: legacyDraft }
    const draftOrder = [legacyDraft.id]
    persistDrafts(storage, draftsById, draftOrder)
    return { draftsById, draftOrder }
  } catch {
    clearLegacyNewDraftInput(storage)
    return { draftsById: {}, draftOrder: [] }
  }
}
