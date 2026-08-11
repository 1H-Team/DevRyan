import { describe, expect, test } from "bun:test"
import {
  clearCommittedComposerText,
  clearSubmittedComposerAfterSend,
  mergeSubmittedAttachmentsForRecovery,
} from "./chatInputSubmitCleanup"

const createTextarea = () => ({ value: "restored prompt" })

describe("chat input submit cleanup", () => {
  test("committed send clears restored composer text before async submit", () => {
    const calls: string[] = []
    const textarea = createTextarea()
    let messageRef = "restored prompt"

    clearCommittedComposerText({
      attachedFilesCount: 1,
      textarea,
      clearPendingInputText: () => calls.push("clearPendingInputText"),
      clearPendingDraftPersist: () => calls.push("clearPendingDraftPersist"),
      clearDraftTarget: () => calls.push("clearDraftTarget"),
      syncMessageRef: (value) => {
        messageRef = value
        calls.push(`syncMessageRef:${value}`)
      },
      setMessage: (value) => calls.push(`setMessage:${value}`),
      clearAttachedFiles: () => calls.push("clearAttachedFiles"),
    })

    expect(textarea.value).toBe("")
    expect(messageRef).toBe("")
    expect(calls).toEqual([
      "clearPendingInputText",
      "clearPendingDraftPersist",
      "clearDraftTarget",
      "syncMessageRef:",
      "setMessage:",
      "clearAttachedFiles",
    ])
  })

  test("successful non-queued cleanup clears restored composer state", () => {
    const calls: string[] = []
    const textarea = createTextarea()

    clearSubmittedComposerAfterSend({
      queuedOnly: false,
      textarea,
      clearPendingInputText: () => calls.push("clearPendingInputText"),
      clearPendingDraftPersist: () => calls.push("clearPendingDraftPersist"),
      setMessage: (value) => calls.push(`setMessage:${value}`),
      clearConfirmedMentions: () => calls.push("clearConfirmedMentions"),
      clearDraftTarget: () => calls.push("clearDraftTarget"),
      setHistoryIndex: (value) => calls.push(`setHistoryIndex:${value}`),
      setDraftMessage: (value) => calls.push(`setDraftMessage:${value}`),
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
      "setExpandedInput:false",
    ])
  })

  test("queued-only cleanup is a no-op", () => {
    const calls: string[] = []
    const textarea = createTextarea()

    clearSubmittedComposerAfterSend({
      queuedOnly: true,
      textarea,
      clearPendingInputText: () => calls.push("clearPendingInputText"),
      clearPendingDraftPersist: () => calls.push("clearPendingDraftPersist"),
      setMessage: (value) => calls.push(`setMessage:${value}`),
      clearConfirmedMentions: () => calls.push("clearConfirmedMentions"),
      clearDraftTarget: () => calls.push("clearDraftTarget"),
      setHistoryIndex: (value) => calls.push(`setHistoryIndex:${value}`),
      setDraftMessage: (value) => calls.push(`setDraftMessage:${value}`),
      setExpandedInput: (value) => calls.push(`setExpandedInput:${String(value)}`),
    })

    expect(textarea.value).toBe("restored prompt")
    expect(calls).toEqual([])
  })

  test("cancels pending draft persistence before clearing the visible message", () => {
    const calls: string[] = []

    clearSubmittedComposerAfterSend({
      queuedOnly: false,
      textarea: null,
      clearPendingInputText: () => calls.push("clearPendingInputText"),
      clearPendingDraftPersist: () => calls.push("clearPendingDraftPersist"),
      setMessage: (value) => calls.push(`setMessage:${value}`),
      clearConfirmedMentions: () => calls.push("clearConfirmedMentions"),
      clearDraftTarget: () => calls.push("clearDraftTarget"),
      setHistoryIndex: (value) => calls.push(`setHistoryIndex:${value}`),
      setDraftMessage: (value) => calls.push(`setDraftMessage:${value}`),
      setExpandedInput: (value) => calls.push(`setExpandedInput:${String(value)}`),
    })

    expect(calls.indexOf("clearPendingDraftPersist")).toBeLessThan(calls.indexOf("setMessage:"))
    expect(calls.indexOf("clearPendingDraftPersist")).toBeLessThan(calls.indexOf("clearDraftTarget"))
    expect(calls).not.toContain("clearAttachedFiles")
  })

  test("does not clear attachments during late successful cleanup", () => {
    const calls: string[] = []

    clearSubmittedComposerAfterSend({
      queuedOnly: false,
      textarea: null,
      clearPendingInputText: () => calls.push("clearPendingInputText"),
      clearPendingDraftPersist: () => calls.push("clearPendingDraftPersist"),
      setMessage: (value) => calls.push(`setMessage:${value}`),
      clearConfirmedMentions: () => calls.push("clearConfirmedMentions"),
      clearDraftTarget: () => calls.push("clearDraftTarget"),
      setHistoryIndex: (value) => calls.push(`setHistoryIndex:${value}`),
      setDraftMessage: (value) => calls.push(`setDraftMessage:${value}`),
      setExpandedInput: (value) => calls.push(`setExpandedInput:${String(value)}`),
    })

    expect(calls).not.toContain("clearAttachedFiles")
  })

  test("restores submitted attachments once and preserves newer attachments", () => {
    const submitted = [
      { id: "screenshot-a", filename: "a.png" },
      { id: "screenshot-b", filename: "b.png" },
      { id: "screenshot-a", filename: "duplicate-a.png" },
    ]
    const current = [
      { id: "screenshot-b", filename: "existing-b.png" },
      { id: "screenshot-c", filename: "new.png" },
    ]

    expect(mergeSubmittedAttachmentsForRecovery(submitted, current)).toEqual([
      { id: "screenshot-a", filename: "a.png" },
      { id: "screenshot-b", filename: "b.png" },
      { id: "screenshot-c", filename: "new.png" },
    ])
  })
})
