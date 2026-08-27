import { beforeEach, describe, expect, test } from "bun:test"
import {
  CHAT_DRAFTS_STORAGE_KEY,
  LEGACY_NEW_INPUT_DRAFT_KEY,
  clearLegacyNewDraftInput,
  getDraftConfirmedMentionsStorageKey,
  getDraftInputStorageKey,
  getSessionConfirmedMentionsStorageKey,
  getSessionInputStorageKey,
  persistDrafts,
  readPersistedDrafts,
  removePersistedDraftInput,
  removePersistedSessionInput,
  subscribePersistedSessionInputRemoval,
} from "./session-draft-storage"

const createMemoryStorage = (): Storage => {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
    removeItem: (key: string) => {
      store.delete(key)
    },
    clear: () => {
      store.clear()
    },
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size
    },
  } as Storage
}

describe("session draft storage", () => {
  let storage: Storage

  beforeEach(() => {
    storage = createMemoryStorage()
  })

  test("migrates legacy new-input draft once and clears the legacy key", () => {
    storage.setItem(LEGACY_NEW_INPUT_DRAFT_KEY, "legacy unsent text")

    const first = readPersistedDrafts(storage)
    const firstDraftId = first.draftOrder[0]

    expect(firstDraftId).toBeTruthy()
    expect(first.draftsById[firstDraftId]?.text).toBe("legacy unsent text")
    expect(storage.getItem(LEGACY_NEW_INPUT_DRAFT_KEY)).toBeNull()
    expect(storage.getItem(CHAT_DRAFTS_STORAGE_KEY)).toContain("legacy unsent text")

    const second = readPersistedDrafts(storage)
    expect(second.draftOrder).toEqual([firstDraftId])
  })

  test("canonical drafts win over stale legacy new-input storage and legacy is cleared", () => {
    storage.setItem(LEGACY_NEW_INPUT_DRAFT_KEY, "stale sent text")
    storage.setItem(CHAT_DRAFTS_STORAGE_KEY, JSON.stringify({
      order: ["draft-canonical"],
      drafts: [{
        id: "draft-canonical",
        text: "canonical unsent text",
        createdAt: 1,
        updatedAt: 1,
        selectedProjectId: null,
        directoryOverride: null,
        parentID: null,
      }],
    }))

    const result = readPersistedDrafts(storage)

    expect(result.draftOrder).toEqual(["draft-canonical"])
    expect(result.draftsById["draft-canonical"]?.text).toBe("canonical unsent text")
    expect(storage.getItem(LEGACY_NEW_INPUT_DRAFT_KEY)).toBeNull()
  })

  test("returns empty draft state for malformed canonical storage", () => {
    storage.setItem(CHAT_DRAFTS_STORAGE_KEY, "{not json")

    expect(readPersistedDrafts(storage)).toEqual({ draftsById: {}, draftOrder: [] })
  })

  test("persists only non-empty canonical drafts", () => {
    persistDrafts(storage, {
      "draft-empty": {
        id: "draft-empty",
        text: "   ",
        createdAt: 1,
        updatedAt: 1,
        selectedProjectId: null,
        directoryOverride: null,
        parentID: null,
      },
      "draft-full": {
        id: "draft-full",
        text: "keep me",
        createdAt: 2,
        updatedAt: 2,
        selectedProjectId: null,
        directoryOverride: "/repo",
        parentID: null,
      },
    }, ["draft-empty", "draft-full"])

    const raw = storage.getItem(CHAT_DRAFTS_STORAGE_KEY)
    expect(raw).toContain("draft-full")
    expect(raw).not.toContain("draft-empty")
  })

  test("round-trips persisted draft send config", () => {
    persistDrafts(storage, {
      "draft-config": {
        id: "draft-config",
        text: "keep configured send",
        createdAt: 1,
        updatedAt: 1,
        selectedProjectId: null,
        directoryOverride: "/repo",
        parentID: null,
        sendConfig: {
          providerID: "openai",
          modelID: "gpt-5.2",
          agent: "reviewer",
          variant: "low",
          planMode: true,
          modelProvenance: "explicit",
        },
      },
    }, ["draft-config"])

    const result = readPersistedDrafts(storage)

    expect(result.draftOrder).toEqual(["draft-config"])
    expect(result.draftsById["draft-config"]?.sendConfig).toEqual({
      providerID: "openai",
      modelID: "gpt-5.2",
      agent: "reviewer",
      variant: "low",
      planMode: true,
      modelProvenance: "explicit",
    })
  })

  test("preserves legacy draft send config without provenance on round-trip", () => {
    storage.setItem(CHAT_DRAFTS_STORAGE_KEY, JSON.stringify({
      order: ["draft-legacy"],
      drafts: [{
        id: "draft-legacy",
        text: "legacy configured send",
        createdAt: 1,
        updatedAt: 1,
        selectedProjectId: null,
        directoryOverride: "/repo",
        parentID: null,
        sendConfig: {
          providerID: "openai",
          modelID: "gpt-5.2",
          agent: "reviewer",
        },
      }],
    }))

    const result = readPersistedDrafts(storage)

    expect(result.draftsById["draft-legacy"]?.sendConfig).toEqual({
      providerID: "openai",
      modelID: "gpt-5.2",
      agent: "reviewer",
    })
    expect(result.draftsById["draft-legacy"]?.sendConfig?.modelProvenance).toBe(undefined)
  })

  test("round-trips agent-default model provenance", () => {
    persistDrafts(storage, {
      "draft-agent-default": {
        id: "draft-agent-default",
        text: "agent default send",
        createdAt: 1,
        updatedAt: 1,
        selectedProjectId: null,
        directoryOverride: "/repo",
        parentID: null,
        sendConfig: {
          providerID: "opencode",
          modelID: "small",
          agent: "Orchestrator",
          modelProvenance: "agent-default",
        },
      },
    }, ["draft-agent-default"])

    const result = readPersistedDrafts(storage)

    expect(result.draftsById["draft-agent-default"]?.sendConfig).toEqual({
      providerID: "opencode",
      modelID: "small",
      agent: "Orchestrator",
      modelProvenance: "agent-default",
    })
  })

  test("persists empty drafts when they contain explicit send config", () => {
    persistDrafts(storage, {
      "draft-config-only": {
        id: "draft-config-only",
        text: "   ",
        createdAt: 1,
        updatedAt: 1,
        selectedProjectId: null,
        directoryOverride: "/repo",
        parentID: null,
        sendConfig: {
          providerID: "openai",
          modelID: "gpt-5.2",
        },
      },
    }, ["draft-config-only"])

    const result = readPersistedDrafts(storage)

    expect(result.draftOrder).toEqual(["draft-config-only"])
    expect(result.draftsById["draft-config-only"]?.sendConfig).toEqual({
      providerID: "openai",
      modelID: "gpt-5.2",
    })
  })

  test("persists attachment-only drafts with lightweight attachment metadata", () => {
    const storage = createMemoryStorage()
    const now = Date.now()
    const draft = {
      id: "draft-attachment-only",
      text: "",
      attachmentCount: 2,
      createdAt: now,
      updatedAt: now,
      selectedProjectId: null,
      directoryOverride: null,
      parentID: null,
    }

    persistDrafts(storage, { [draft.id]: draft }, [draft.id])

    expect(readPersistedDrafts(storage).draftsById[draft.id]?.attachmentCount).toBe(2)
  })

  test("removes per-draft composer and mention storage during promotion cleanup", () => {
    storage.setItem(getDraftInputStorageKey("draft-send"), "sent text")
    storage.setItem(getDraftConfirmedMentionsStorageKey("draft-send"), JSON.stringify(["README.md"]))
    storage.setItem(LEGACY_NEW_INPUT_DRAFT_KEY, "stale text")

    removePersistedDraftInput(storage, "draft-send")
    clearLegacyNewDraftInput(storage)

    expect(storage.getItem(getDraftInputStorageKey("draft-send"))).toBeNull()
    expect(storage.getItem(getDraftConfirmedMentionsStorageKey("draft-send"))).toBeNull()
    expect(storage.getItem(LEGACY_NEW_INPUT_DRAFT_KEY)).toBeNull()
  })

  test("removes one session's composer storage and synchronously announces retirement", () => {
    const removedSessionIds: string[] = []
    const unsubscribe = subscribePersistedSessionInputRemoval((sessionId) => {
      removedSessionIds.push(sessionId)
    })
    storage.setItem(getSessionInputStorageKey("session-delete"), "unsent text")
    storage.setItem(getSessionConfirmedMentionsStorageKey("session-delete"), JSON.stringify(["README.md"]))
    storage.setItem(getSessionInputStorageKey("session-keep"), "keep text")

    try {
      removePersistedSessionInput("session-delete", storage)

      expect(storage.getItem(getSessionInputStorageKey("session-delete"))).toBeNull()
      expect(storage.getItem(getSessionConfirmedMentionsStorageKey("session-delete"))).toBeNull()
      expect(storage.getItem(getSessionInputStorageKey("session-keep"))).toBe("keep text")
      expect(removedSessionIds).toEqual(["session-delete"])
    } finally {
      unsubscribe()
    }
  })
})
