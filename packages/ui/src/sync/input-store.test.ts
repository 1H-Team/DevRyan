import { beforeEach, describe, expect, test } from "bun:test"
import {
  getSessionComposerRevision,
  markSessionComposerEdited,
  setActiveComposerSession,
  useInputStore,
} from "./input-store"

class MockFileReader {
  result: string | ArrayBuffer | null = null
  onload: ((this: FileReader, event: ProgressEvent<FileReader>) => unknown) | null = null

  readAsDataURL() {
    pendingReaders.push(this)
  }
}

const pendingReaders: MockFileReader[] = []

const resolveReader = (reader: MockFileReader, result: string) => {
  reader.result = result
  reader.onload?.call(reader as unknown as FileReader, {} as ProgressEvent<FileReader>)
}

describe("input-store attachments", () => {
  beforeEach(() => {
    pendingReaders.length = 0
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
})
