import { describe, expect, test } from "bun:test"
import {
  createComposerDraftPersistenceController,
  getComposerConfirmedMentionsStorageKey,
  getComposerDraftStorageKey,
  resolveComposerDraftTarget,
} from "./chatInputDraftPersistence"

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

describe("chat input draft persistence", () => {
  test('a failed first prompt restores its session without overwriting another composer or a newer edit', () => {
    const controller = createComposerDraftPersistenceController({ storage: createMemoryStorage(), updateDraftText: () => {} })
    const session = resolveComposerDraftTarget('created-session', null)
    const other = resolveComposerDraftTarget(null, 'other-draft')
    controller.save(other, 'keep this draft', new Set())
    controller.restoreIfEmpty(session, 'failed first prompt')
    expect(controller.load(session)).toBe('failed first prompt')
    expect(controller.load(other)).toBe('keep this draft')
    controller.save(session, 'newer session edit', new Set())
    controller.restoreIfEmpty(session, 'old failure')
    expect(controller.load(session)).toBe('newer session edit')
  })
  test('late composer saves cannot recreate a promoted or deleted draft', () => {
    const storage = createMemoryStorage()
    let exists = true
    const updates: string[] = []
    const controller = createComposerDraftPersistenceController({ storage,
      draftExists: () => exists, updateDraftText: (_id, text) => updates.push(text) })
    const target = resolveComposerDraftTarget(null, 'original')
    controller.save(target, 'original text', new Set())
    controller.clear(target)
    exists = false
    controller.save(target, 'late text', new Set(['file']))
    expect(storage.getItem(getComposerDraftStorageKey(target)!)).toBeNull()
    expect(updates).toEqual(['original text'])
  })
  test("none targets never write legacy new-draft storage", () => {
    const storage = createMemoryStorage()
    const updates: Array<{ draftId: string; text: string }> = []
    const controller = createComposerDraftPersistenceController({
      storage,
      updateDraftText: (draftId, text) => updates.push({ draftId, text }),
    })

    const none = resolveComposerDraftTarget(null, null)
    controller.save(none, "sent text", new Set(["README.md"]))
    controller.clear(none)

    expect(getComposerDraftStorageKey(none)).toBeNull()
    expect(storage.getItem("openchamber_chat_input_draft_new")).toBeNull()
    expect(storage.length).toBe(0)
    expect(updates).toEqual([])
  })

  test("retired draft targets suppress saves from delayed paths", () => {
    const storage = createMemoryStorage()
    const updates: Array<{ draftId: string; text: string }> = []
    const controller = createComposerDraftPersistenceController({
      storage,
      updateDraftText: (draftId, text) => updates.push({ draftId, text }),
    })
    const draft = resolveComposerDraftTarget(null, "draft-send")

    controller.save(draft, "before send", new Set())
    controller.retire(draft)
    controller.save(draft, "after send", new Set())

    expect(storage.getItem("openchamber_chat_input_draft_draft_draft-send")).toBeNull()
    expect(updates).toEqual([{ draftId: "draft-send", text: "before send" }])
  })

  test("existing session targets still persist normally", () => {
    const storage = createMemoryStorage()
    const controller = createComposerDraftPersistenceController({
      storage,
      updateDraftText: () => {
        throw new Error("session targets must not update draft state")
      },
    })
    const session = resolveComposerDraftTarget("session-a", null)

    controller.save(session, "unsent session text", new Set())

    expect(storage.getItem("openchamber_chat_input_draft_session-a")).toBe("unsent session text")
  })

  test("retired session targets suppress target-switch writeback of text and mentions", () => {
    const storage = createMemoryStorage()
    const controller = createComposerDraftPersistenceController({
      storage,
      updateDraftText: () => {
        throw new Error("session targets must not update draft state")
      },
    })
    const session = resolveComposerDraftTarget("session-delete", null)

    controller.save(session, "unsent @README.md", new Set(["README.md"]))
    controller.retire(session)
    controller.save(session, "resurrected @README.md", new Set(["README.md"]))

    expect(storage.getItem(getComposerDraftStorageKey(session)!)).toBeNull()
    expect(storage.getItem(getComposerConfirmedMentionsStorageKey(session)!)).toBeNull()
  })
})
