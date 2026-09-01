import {
  getSessionConfirmedMentionsStorageKey,
  getSessionInputStorageKey,
} from "@/sync/session-draft-storage"
import {
  getComposerTargetKey,
  resolveComposerTarget,
  type ComposerTarget,
} from "@/sync/composer-target"

export type ComposerDraftTarget = ComposerTarget

export const resolveComposerDraftTarget = (
  sessionId: string | null | undefined,
  draftId: string | null | undefined,
): ComposerDraftTarget => resolveComposerTarget(sessionId, draftId)

export const getComposerDraftTargetKey = (target: ComposerDraftTarget): string => getComposerTargetKey(target)

export const getComposerDraftStorageKey = (target: ComposerDraftTarget): string | null => {
  if (target.kind === "session") return getSessionInputStorageKey(target.id)
  if (target.kind === "draft") return `openchamber_chat_input_draft_draft_${target.id}`
  return null
}

export const getComposerConfirmedMentionsStorageKey = (target: ComposerDraftTarget): string | null => {
  if (target.kind === "session") return getSessionConfirmedMentionsStorageKey(target.id)
  if (target.kind === "draft") return `openchamber_chat_confirmed_mentions_draft_${target.id}`
  return null
}

const readStorage = (storage: Storage, key: string | null): string => {
  if (!key) return ""
  try {
    return storage.getItem(key) ?? ""
  } catch {
    return ""
  }
}

const writeStorage = (storage: Storage, key: string | null, value: string): void => {
  if (!key) return
  try {
    if (value) {
      storage.setItem(key, value)
    } else {
      storage.removeItem(key)
    }
  } catch {
    // Ignore storage errors.
  }
}

const loadMentions = (storage: Storage, target: ComposerDraftTarget): Set<string> => {
  const raw = readStorage(storage, getComposerConfirmedMentionsStorageKey(target))
  if (!raw) return new Set()
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((value): value is string => typeof value === "string"))
  } catch {
    return new Set()
  }
}

const saveMentions = (storage: Storage, target: ComposerDraftTarget, mentions: Set<string>): void => {
  const key = getComposerConfirmedMentionsStorageKey(target)
  if (!key) return
  try {
    if (mentions.size > 0) {
      storage.setItem(key, JSON.stringify([...mentions]))
    } else {
      storage.removeItem(key)
    }
  } catch {
    // Ignore storage errors.
  }
}

export const createComposerDraftPersistenceController = (options: {
  storage: Storage
  updateDraftText: (draftId: string, text: string) => void
  draftExists?: (draftId: string) => boolean
}) => {
  const retiredTargetKeys = new Set<string>()
  const lastPersistedDraftByKey = new Map<string, string>()

  const isRetired = (target: ComposerDraftTarget): boolean =>
    target.kind !== "none" && retiredTargetKeys.has(getComposerDraftTargetKey(target))

  const load = (target: ComposerDraftTarget): string =>
    readStorage(options.storage, getComposerDraftStorageKey(target))

  const loadConfirmedMentions = (target: ComposerDraftTarget): Set<string> =>
    loadMentions(options.storage, target)

  const clear = (target: ComposerDraftTarget): void => {
    const key = getComposerDraftStorageKey(target)
    writeStorage(options.storage, key, "")
    saveMentions(options.storage, target, new Set())
    if (key) lastPersistedDraftByKey.set(key, "")
  }

  const save = (target: ComposerDraftTarget, draft: string, confirmedMentions: Set<string>): Set<string> => {
    if (target.kind === "none" || isRetired(target)) {
      return confirmedMentions
    }
    // Promotion/deletion may complete before the mounted composer's target
    // effect. Never let that old effect recreate an orphaned draft input key.
    if (target.kind === 'draft' && options.draftExists?.(target.id) === false) return confirmedMentions

    const key = getComposerDraftStorageKey(target)
    if (!key) return confirmedMentions
    if (lastPersistedDraftByKey.get(key) === draft) {
      return confirmedMentions
    }

    writeStorage(options.storage, key, draft)
    if (target.kind === "draft") {
      options.updateDraftText(target.id, draft)
    }

    const activeMentions = new Set<string>()
    for (const mention of confirmedMentions) {
      if (draft.includes(`@${mention}`)) {
        activeMentions.add(mention)
      }
    }
    saveMentions(options.storage, target, activeMentions)
    lastPersistedDraftByKey.set(key, draft)
    return activeMentions
  }

  const retire = (target: ComposerDraftTarget): void => {
    if (target.kind === "none") return
    retiredTargetKeys.add(getComposerDraftTargetKey(target))
    clear(target)
  }

  const release = (target: ComposerDraftTarget): void => {
    if (target.kind === "none") return
    retiredTargetKeys.delete(getComposerDraftTargetKey(target))
  }

  const restoreIfEmpty = (target: ComposerDraftTarget, draft: string): void => {
    if (!load(target)) save(target, draft, new Set())
  }

  return {
    clear,
    isRetired,
    load,
    loadConfirmedMentions,
    release,
    retire,
    restoreIfEmpty,
    save,
  }
}
