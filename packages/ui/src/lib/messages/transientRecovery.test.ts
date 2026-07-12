import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { TRANSIENT_CONTINUATION_PROMPT, planManualRecovery, planTransientRecovery } from "./transientRecovery"

function makeMessage(id: string, role: "user" | "assistant", extra: Record<string, unknown> = {}): Message {
  return {
    id,
    sessionID: "session-a",
    role,
    time: { created: 1 },
    ...extra,
  } as unknown as Message
}

function makePart(part: Record<string, unknown>): Part {
  return {
    id: String(part.id ?? `part-${Math.random()}`),
    sessionID: "session-a",
    messageID: String(part.messageID ?? "message-a"),
    ...part,
  } as unknown as Part
}

function getPartsFrom(records: Record<string, Part[]>) {
  return (messageId: string): Part[] => records[messageId] ?? []
}

describe("planTransientRecovery", () => {
  test("plans manual recovery from a retry status without requiring an assistant error message", () => {
    const messages = [
      makeMessage("user-1", "user", {
        model: { providerID: "opencode-go", modelID: "deepseek-v4-flash" },
      }),
      makeMessage("assistant-partial", "assistant"),
    ]
    const getParts = getPartsFrom({
      "user-1": [makePart({ type: "text", text: "Finish the task", messageID: "user-1" })],
      "assistant-partial": [makePart({ type: "text", text: "Partial work", messageID: "assistant-partial" })],
    })

    const plan = planManualRecovery({ messages, getParts, anchorUserMessageId: "user-1" })
    expect({
      mode: plan?.mode,
      anchorUserMessageId: plan?.anchorUserMessageId,
      content: plan?.content,
    }).toEqual({
      mode: "continue",
      anchorUserMessageId: "user-1",
      content: TRANSIENT_CONTINUATION_PROMPT,
    })
  })

  test("resends the original prompt when the first assistant stream produced no content", () => {
    const messages = [
      makeMessage("user-1", "user"),
      makeMessage("assistant-error", "assistant", {
        providerID: "opencode",
        modelID: "nemotron-3-ultra-free",
      }),
    ]
    const getParts = getPartsFrom({
      "user-1": [makePart({ type: "text", text: "Finish the implementation", messageID: "user-1" })],
      "assistant-error": [],
    })

    expect(planTransientRecovery({ messages, getParts, erroredMessageId: "assistant-error" })).toEqual({
      mode: "resend",
      anchorUserMessageId: "user-1",
      erroredMessageId: "assistant-error",
      content: "Finish the implementation",
      attachments: [],
      providerID: "opencode",
      modelID: "nemotron-3-ultra-free",
    })
  })

  test("continues instead of duplicating the prompt when the turn already rendered assistant work", () => {
    const messages = [
      makeMessage("user-1", "user"),
      makeMessage("assistant-step", "assistant"),
      makeMessage("assistant-error", "assistant"),
    ]
    const getParts = getPartsFrom({
      "user-1": [makePart({ type: "text", text: "Build the feature", messageID: "user-1" })],
      "assistant-step": [makePart({ type: "text", text: "I updated the server.", messageID: "assistant-step" })],
      "assistant-error": [],
    })

    const plan = planTransientRecovery({ messages, getParts, erroredMessageId: "assistant-error" })
    expect(plan?.mode).toBe("continue")
    expect(plan?.anchorUserMessageId).toBe("user-1")
    expect(plan?.content).toBe(TRANSIENT_CONTINUATION_PROMPT)
    expect(plan?.attachments).toEqual([])
  })

  test("treats partial content on the errored assistant message as work to continue", () => {
    const messages = [makeMessage("user-1", "user"), makeMessage("assistant-error", "assistant")]
    const getParts = getPartsFrom({
      "user-1": [makePart({ type: "text", text: "Build the feature", messageID: "user-1" })],
      "assistant-error": [makePart({ type: "text", text: "Partial result", messageID: "assistant-error" })],
    })

    expect(planTransientRecovery({ messages, getParts, erroredMessageId: "assistant-error" })?.mode).toBe("continue")
  })

  test("maps non-synthetic attachments and excludes synthetic prompt parts", () => {
    const messages = [makeMessage("user-1", "user"), makeMessage("assistant-error", "assistant")]
    const getParts = getPartsFrom({
      "user-1": [
        makePart({ type: "text", text: "Analyze this", messageID: "user-1" }),
        makePart({ type: "text", text: "hidden server context", synthetic: true, messageID: "user-1" }),
        makePart({ type: "file", mime: "image/png", url: "data:image/png;base64,abc", filename: "chart.png", messageID: "user-1" }),
        makePart({ type: "file", mime: "text/plain", url: "file:///tmp/hidden.txt", filename: "hidden.txt", synthetic: true, messageID: "user-1" }),
      ],
      "assistant-error": [],
    })

    const plan = planTransientRecovery({ messages, getParts, erroredMessageId: "assistant-error" })
    expect(plan?.mode).toBe("resend")
    expect(plan?.content).toBe("Analyze this")
    expect(plan?.attachments).toEqual([{
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,abc",
        filename: "chart.png",
    }])
  })

  test("preserves SDK-valid file parts that omit a filename", () => {
    const messages = [makeMessage("user-1", "user"), makeMessage("assistant-error", "assistant")]
    const getParts = getPartsFrom({
      "user-1": [
        makePart({ type: "text", text: "Analyze the attachment", messageID: "user-1" }),
        makePart({ type: "file", mime: "text/plain", url: "file:///tmp/context.txt", messageID: "user-1" }),
      ],
      "assistant-error": [],
    })

    const plan = planTransientRecovery({ messages, getParts, erroredMessageId: "assistant-error" })
    expect(plan?.attachments).toEqual([{
      mimeType: "text/plain",
      dataUrl: "file:///tmp/context.txt",
      filename: "attachment",
    }])
  })

  test("returns null when the error is no longer latest or no user anchor exists", () => {
    const error = makeMessage("assistant-error", "assistant")
    expect(planTransientRecovery({
      messages: [makeMessage("user-1", "user"), error, makeMessage("user-2", "user")],
      getParts: () => [],
      erroredMessageId: "assistant-error",
    })).toBeNull()

    expect(planTransientRecovery({
      messages: [error],
      getParts: () => [],
      erroredMessageId: "assistant-error",
    })).toBeNull()
  })
})
