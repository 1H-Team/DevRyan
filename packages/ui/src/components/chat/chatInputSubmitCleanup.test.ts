import { describe, expect, test } from "bun:test"
import { clearCommittedComposerText, clearSubmittedComposerAfterSend } from "./chatInputSubmitCleanup"

const createTextarea = () => ({ value: "restored prompt" })

describe("chat input submit cleanup", () => {
  test("committed send clears restored composer text before async submit", () => {
    const calls: string[] = []
    const textarea = createTextarea()
    let messageRef = "restored prompt"

    clearCommittedComposerText({
      textarea,
      clearPendingInputText: () => calls.push("clearPendingInputText"),
      clearPendingDraftPersist: () => calls.push("clearPendingDraftPersist"),
      clearDraftTarget: () => calls.push("clearDraftTarget"),
      syncMessageRef: (value) => {
        messageRef = value
        calls.push(`syncMessageRef:${value}`)
      },
      setMessage: (value) => calls.push(`setMessage:${value}`),
    })

    expect(textarea.value).toBe("")
    expect(messageRef).toBe("")
    expect(calls).toEqual([
      "clearPendingInputText",
      "clearPendingDraftPersist",
      "clearDraftTarget",
      "syncMessageRef:",
      "setMessage:",
    ])
  })

  test("successful non-queued cleanup clears restored composer state", () => {
    const calls: string[] = []
    const textarea = createTextarea()

    clearSubmittedComposerAfterSend({
      queuedOnly: false,
      attachedFilesCount: 1,
      textarea,
      clearPendingInputText: () => calls.push("clearPendingInputText"),
      clearPendingDraftPersist: () => calls.push("clearPendingDraftPersist"),
      setMessage: (value) => calls.push(`setMessage:${value}`),
      clearConfirmedMentions: () => calls.push("clearConfirmedMentions"),
      clearDraftTarget: () => calls.push("clearDraftTarget"),
      setHistoryIndex: (value) => calls.push(`setHistoryIndex:${value}`),
      setDraftMessage: (value) => calls.push(`setDraftMessage:${value}`),
      clearAttachedFiles: () => calls.push("clearAttachedFiles"),
      setExpandedInput: (value) => calls.push(`setExpandedInput:${String(value)}`),
    })

    expect(textarea.value).toBe("")
    expect(calls).toEqual([
      "clearPendingInputText",
      "clearPendingDraftPersist",
      "setMessage:",
      "clearConfirmedMentions",
      "clearDraftTarget",
      "setHistoryIndex:-1",
      "setDraftMessage:",
      "clearAttachedFiles",
      "setExpandedInput:false",
    ])
  })

  test("queued-only cleanup is a no-op", () => {
    const calls: string[] = []
    const textarea = createTextarea()

    clearSubmittedComposerAfterSend({
      queuedOnly: true,
      attachedFilesCount: 1,
      textarea,
      clearPendingInputText: () => calls.push("clearPendingInputText"),
      clearPendingDraftPersist: () => calls.push("clearPendingDraftPersist"),
      setMessage: (value) => calls.push(`setMessage:${value}`),
      clearConfirmedMentions: () => calls.push("clearConfirmedMentions"),
      clearDraftTarget: () => calls.push("clearDraftTarget"),
      setHistoryIndex: (value) => calls.push(`setHistoryIndex:${value}`),
      setDraftMessage: (value) => calls.push(`setDraftMessage:${value}`),
      clearAttachedFiles: () => calls.push("clearAttachedFiles"),
      setExpandedInput: (value) => calls.push(`setExpandedInput:${String(value)}`),
    })

    expect(textarea.value).toBe("restored prompt")
    expect(calls).toEqual([])
  })

  test("cancels pending draft persistence before clearing the visible message", () => {
    const calls: string[] = []

    clearSubmittedComposerAfterSend({
      queuedOnly: false,
      attachedFilesCount: 0,
      textarea: null,
      clearPendingInputText: () => calls.push("clearPendingInputText"),
      clearPendingDraftPersist: () => calls.push("clearPendingDraftPersist"),
      setMessage: (value) => calls.push(`setMessage:${value}`),
      clearConfirmedMentions: () => calls.push("clearConfirmedMentions"),
      clearDraftTarget: () => calls.push("clearDraftTarget"),
      setHistoryIndex: (value) => calls.push(`setHistoryIndex:${value}`),
      setDraftMessage: (value) => calls.push(`setDraftMessage:${value}`),
      clearAttachedFiles: () => calls.push("clearAttachedFiles"),
      setExpandedInput: (value) => calls.push(`setExpandedInput:${String(value)}`),
    })

    expect(calls.indexOf("clearPendingDraftPersist")).toBeLessThan(calls.indexOf("setMessage:"))
    expect(calls.indexOf("clearPendingDraftPersist")).toBeLessThan(calls.indexOf("clearDraftTarget"))
    expect(calls).not.toContain("clearAttachedFiles")
  })
})
