import { beforeEach, describe, expect, test } from "bun:test"
import {
  getSessionComposerRevision,
  markSessionComposerEdited,
  resetComposerAttachmentRuntimeForTests,
  setActiveComposerSession,
  useInputStore,
  waitForComposerAttachmentPersistenceForTests,
} from "./input-store"
import {
  setComposerAttachmentPersistenceForTests,
  type ComposerAttachmentPersistence,
  type PersistedComposerAttachment,
} from "./composer-attachment-storage"
import { getStoragePrincipal, setStoragePrincipal } from "@/stores/utils/safeStorage"
import { removePersistedSessionInput } from "./session-draft-storage"

class MockFileReader {
  result: string | ArrayBuffer | null = null
  onload: ((this: FileReader, event: ProgressEvent<FileReader>) => unknown) | null = null

  readAsDataURL() {
    pendingReaders.push(this)
  }
}

const pendingReaders: MockFileReader[] = []
let persistedAttachments: Map<string, unknown>

const createMemoryAttachmentPersistence = (): ComposerAttachmentPersistence => ({
  read: async (key) => persistedAttachments.get(key),
  write: async (key, records) => {
    persistedAttachments.set(key, records.map((record) => ({ ...record })))
  },
  remove: async (key) => {
    persistedAttachments.delete(key)
  },
})

const resolveReader = (reader: MockFileReader, result: string) => {
  reader.result = result
  reader.onload?.call(reader as unknown as FileReader, {} as ProgressEvent<FileReader>)
}

describe("input-store attachments", () => {
  beforeEach(() => {
    pendingReaders.length = 0
    persistedAttachments = new Map()
    setComposerAttachmentPersistenceForTests(createMemoryAttachmentPersistence())
    resetComposerAttachmentRuntimeForTests()
    globalThis.FileReader = MockFileReader as unknown as typeof FileReader
    setActiveComposerSession(null)
    useInputStore.setState({
      pendingInputText: null,
      pendingInputMode: "replace",
      pendingSyntheticParts: null,
      activeEditorFile: null,
      pendingRestoredInputs: new Map(),
    })
    useInputStore.getState().setAttachedFiles([])
  })

  test("does not attach a local file that finishes reading after attachments are cleared", async () => {
    const addPromise = useInputStore.getState().addAttachedFile(new File(["hello"], "hello.txt", { type: "text/plain" }))
    expect(pendingReaders).toHaveLength(1)

    useInputStore.getState().clearAttachedFiles()
    resolveReader(pendingReaders[0], "data:text/plain;base64,aGVsbG8=")
    await addPromise

    expect(useInputStore.getState().attachedFiles).toEqual([])
  })

  test("claims composer ownership before an asynchronous attachment read settles", async () => {
    const sessionId = "session-pending-attachment"
    const beforeRevision = getSessionComposerRevision(sessionId)
    setActiveComposerSession(sessionId)

    const addPromise = useInputStore.getState().addAttachedFile(new File(["hello"], "hello.txt", { type: "text/plain" }))

    expect(getSessionComposerRevision(sessionId)).toBe(beforeRevision + 1)
    resolveReader(pendingReaders[0], "data:text/plain;base64,aGVsbG8=")
    await addPromise
  })

  test("does not attach a local file after attached files are replaced", async () => {
    const addPromise = useInputStore.getState().addAttachedFile(new File(["hello"], "hello.txt", { type: "text/plain" }))
    expect(pendingReaders).toHaveLength(1)

    useInputStore.getState().setAttachedFiles([])
    resolveReader(pendingReaders[0], "data:text/plain;base64,aGVsbG8=")
    await addPromise

    expect(useInputStore.getState().attachedFiles).toEqual([])
  })

  test("does not attach a local file after attached files are restored", async () => {
    const addPromise = useInputStore.getState().addAttachedFile(new File(["hello"], "hello.txt", { type: "text/plain" }))
    expect(pendingReaders).toHaveLength(1)

    const restored = new File(["restored"], "restored.txt", { type: "text/plain" })
    useInputStore.getState().setAttachedFiles([{
      id: "restored",
      file: restored,
      dataUrl: "data:text/plain;base64,cmVzdG9yZWQ=",
      mimeType: "text/plain",
      filename: "restored.txt",
      size: restored.size,
      source: "local",
    }])
    resolveReader(pendingReaders[0], "data:text/plain;base64,aGVsbG8=")
    await addPromise

    expect(useInputStore.getState().attachedFiles.map((file) => file.filename)).toEqual(["restored.txt"])
  })

  test("does not attach a VS Code selection that finishes reading after attachments are cleared", async () => {
    const addPromise = useInputStore.getState().addVSCodeSelectionAttachment(
      "/workspace/hello.txt",
      new File(["hello"], "hello.txt", { type: "text/plain" })
    )
    expect(pendingReaders).toHaveLength(1)

    useInputStore.getState().clearAttachedFiles()
    resolveReader(pendingReaders[0], "data:text/plain;base64,aGVsbG8=")
    await addPromise

    expect(useInputStore.getState().attachedFiles).toEqual([])
  })

  test("restores a data URL attachment with decoded byte size", () => {
    useInputStore.getState().addRestoredAttachment({
      url: "data:text/plain;base64,aGVsbG8=",
      mimeType: "text/plain",
      filename: "hello.txt",
    })

    expect(useInputStore.getState().attachedFiles.map((file) => ({
      dataUrl: file.dataUrl,
      mimeType: file.mimeType,
      filename: file.filename,
      size: file.size,
      source: file.source,
    }))).toEqual([{
      dataUrl: "data:text/plain;base64,aGVsbG8=",
      mimeType: "text/plain",
      filename: "hello.txt",
      size: 5,
      source: "server",
    }])
  })

  test("keeps restored input scoped to its session until that session consumes it", () => {
    useInputStore.getState().queueRestoredInput({
      sessionId: "session-restored-target",
      text: "restored prompt",
      attachments: [],
      expectedComposerRevision: 0,
    })

    expect(useInputStore.getState().consumeRestoredInput("session-other", 0)).toBeNull()
    expect(useInputStore.getState().consumeRestoredInput("session-restored-target", 0)?.text).toBe("restored prompt")
    expect(useInputStore.getState().pendingRestoredInputs.size).toBe(0)
  })

  test("discards restored input when its composer changed after revert began", () => {
    const sessionId = "session-edited-during-revert"
    const expectedComposerRevision = getSessionComposerRevision(sessionId)
    useInputStore.getState().queueRestoredInput({
      sessionId,
      text: "stale restored prompt",
      attachments: [],
      expectedComposerRevision,
    })

    const editedRevision = markSessionComposerEdited(sessionId)
    expect(useInputStore.getState().consumeRestoredInput(sessionId, editedRevision)).toBeNull()
    expect(useInputStore.getState().pendingRestoredInputs.size).toBe(0)
  })

  test("keeps ordered attachments isolated per composer target", async () => {
    await useInputStore.getState().activateAttachedFilesTarget("draft:a")

    const first = useInputStore.getState().addAttachedFile(new File(["a"], "a.png", { type: "image/png" }))
    resolveReader(pendingReaders.shift()!, "data:image/png;base64,YQ==")
    await first
    const second = useInputStore.getState().addAttachedFile(new File(["b"], "b.png", { type: "image/png" }))
    resolveReader(pendingReaders.shift()!, "data:image/png;base64,Yg==")
    await second

    await useInputStore.getState().activateAttachedFilesTarget("draft:b")
    const third = useInputStore.getState().addAttachedFile(new File(["c"], "c.png", { type: "image/png" }))
    resolveReader(pendingReaders.shift()!, "data:image/png;base64,Yw==")
    await third

    expect(useInputStore.getState().attachedFiles.map((file) => file.filename)).toEqual(["c.png"])
    await useInputStore.getState().activateAttachedFilesTarget("draft:a")
    expect(useInputStore.getState().attachedFiles.map((file) => file.filename)).toEqual(["a.png", "b.png"])
  })

  test("routes a screenshot that finishes after switching back to its originating draft", async () => {
    await useInputStore.getState().activateAttachedFilesTarget("draft:origin")
    const pending = useInputStore.getState().addAttachedFile(
      new File(["late"], "late.png", { type: "image/png" }),
    )

    await useInputStore.getState().activateAttachedFilesTarget("draft:other")
    resolveReader(pendingReaders.shift()!, "data:image/png;base64,bGF0ZQ==")
    await pending

    expect(useInputStore.getState().attachedFiles).toEqual([])
    await useInputStore.getState().activateAttachedFilesTarget("draft:origin")
    expect(useInputStore.getState().attachedFiles.map((file) => file.filename)).toEqual(["late.png"])
  })

  test("restores target attachments after the runtime cache is reset", async () => {
    await useInputStore.getState().activateAttachedFilesTarget("session:persisted")
    const pending = useInputStore.getState().addAttachedFile(
      new File(["saved"], "saved.png", { type: "image/png" }),
    )
    resolveReader(pendingReaders.shift()!, "data:image/png;base64,c2F2ZWQ=")
    await pending
    await waitForComposerAttachmentPersistenceForTests()

    resetComposerAttachmentRuntimeForTests()
    await useInputStore.getState().activateAttachedFilesTarget("session:persisted")

    expect(useInputStore.getState().attachedFiles.map((file) => ({
      filename: file.filename,
      dataUrl: file.dataUrl,
      source: file.source,
    }))).toEqual([{
      filename: "saved.png",
      dataUrl: "data:image/png;base64,c2F2ZWQ=",
      source: "local",
    }])
  })

  test("ignores invalid persisted records without losing valid ordered records", async () => {
    const valid: PersistedComposerAttachment = {
      version: 1,
      id: "valid",
      dataUrl: "data:image/png;base64,dmFsaWQ=",
      mimeType: "image/png",
      filename: "valid.png",
      size: 5,
      source: "local",
    }
    persistedAttachments.set(`${getStoragePrincipal()}:draft:corrupt`, [
      { version: 99, id: "old" },
      valid,
      { ...valid },
      null,
    ])

    await useInputStore.getState().activateAttachedFilesTarget("draft:corrupt")

    expect(useInputStore.getState().attachedFiles.map((file) => file.id)).toEqual(["valid"])
  })

  test("reports durable storage failure once while retaining runtime attachments", async () => {
    setComposerAttachmentPersistenceForTests({
      read: async () => { throw new Error("storage unavailable") },
      write: async () => { throw new Error("storage unavailable") },
      remove: async () => { throw new Error("storage unavailable") },
    })
    resetComposerAttachmentRuntimeForTests()

    await useInputStore.getState().activateAttachedFilesTarget("draft:failure-a")
    expect(useInputStore.getState().attachmentPersistenceError).toBe("storage unavailable")
    useInputStore.getState().clearAttachmentPersistenceError()

    await useInputStore.getState().activateAttachedFilesTarget("draft:failure-b")
    expect(useInputStore.getState().attachmentPersistenceError).toBeNull()
  })

  test("removes only the retired target and preserves archived-session-style targets", async () => {
    await useInputStore.getState().activateAttachedFilesTarget("session:kept")
    useInputStore.getState().addRestoredAttachment({
      url: "data:image/png;base64,a2VwdA==",
      mimeType: "image/png",
      filename: "kept.png",
    })
    await useInputStore.getState().activateAttachedFilesTarget("draft:removed")
    useInputStore.getState().addRestoredAttachment({
      url: "data:image/png;base64,cmVtb3ZlZA==",
      mimeType: "image/png",
      filename: "removed.png",
    })
    useInputStore.getState().removeAttachedFilesTarget("draft:removed")
    await waitForComposerAttachmentPersistenceForTests()
    resetComposerAttachmentRuntimeForTests()

    await useInputStore.getState().activateAttachedFilesTarget("session:kept")
    expect(useInputStore.getState().attachedFiles.map((file) => file.filename)).toEqual(["kept.png"])
    await useInputStore.getState().activateAttachedFilesTarget("draft:removed")
    expect(useInputStore.getState().attachedFiles).toEqual([])
  })

  test("restores reverted attachments into the explicit session without changing the visible target", async () => {
    await useInputStore.getState().activateAttachedFilesTarget("session:visible")
    useInputStore.getState().replaceRestoredAttachmentsForTarget("session:reverted", [{
      url: "data:image/png;base64,cmV2ZXJ0ZWQ=",
      mimeType: "image/png",
      filename: "reverted.png",
    }])

    expect(useInputStore.getState().activeAttachmentTargetKey).toBe("session:visible")
    expect(useInputStore.getState().attachedFiles).toEqual([])

    await useInputStore.getState().activateAttachedFilesTarget("session:reverted")
    expect(useInputStore.getState().attachedFiles.map((file) => file.filename)).toEqual(["reverted.png"])
  })

  test("does not reuse an in-memory target cache after the storage principal changes", async () => {
    const originalPrincipal = getStoragePrincipal()
    try {
      setStoragePrincipal("composer-user-a")
      await useInputStore.getState().activateAttachedFilesTarget("draft:same")
      useInputStore.getState().addRestoredAttachment({
        url: "data:image/png;base64,dXNlci1h",
        mimeType: "image/png",
        filename: "user-a.png",
      })
      await waitForComposerAttachmentPersistenceForTests()

      setStoragePrincipal("composer-user-b")
      await useInputStore.getState().activateAttachedFilesTarget("draft:same")
      expect(useInputStore.getState().attachedFiles).toEqual([])

      setStoragePrincipal("composer-user-a")
      await useInputStore.getState().activateAttachedFilesTarget("draft:same")
      expect(useInputStore.getState().attachedFiles.map((file) => file.filename)).toEqual(["user-a.png"])
    } finally {
      setStoragePrincipal(originalPrincipal)
      resetComposerAttachmentRuntimeForTests()
    }
  })

  test("permanent session input cleanup removes only that session's attachments", async () => {
    await useInputStore.getState().activateAttachedFilesTarget("session:deleted")
    useInputStore.getState().addRestoredAttachment({
      url: "data:image/png;base64,ZGVsZXRlZA==",
      mimeType: "image/png",
      filename: "deleted.png",
    })
    await useInputStore.getState().activateAttachedFilesTarget("session:preserved")
    useInputStore.getState().addRestoredAttachment({
      url: "data:image/png;base64,cHJlc2VydmVk",
      mimeType: "image/png",
      filename: "preserved.png",
    })

    removePersistedSessionInput("deleted")
    await waitForComposerAttachmentPersistenceForTests()
    resetComposerAttachmentRuntimeForTests()

    await useInputStore.getState().activateAttachedFilesTarget("session:deleted")
    expect(useInputStore.getState().attachedFiles).toEqual([])
    await useInputStore.getState().activateAttachedFilesTarget("session:preserved")
    expect(useInputStore.getState().attachedFiles.map((file) => file.filename)).toEqual(["preserved.png"])
  })
})
