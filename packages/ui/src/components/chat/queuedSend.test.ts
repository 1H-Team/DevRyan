import { beforeEach, describe, expect, test } from "bun:test"
import type { AttachedFile } from "@/stores/types/sessionTypes"
import { useMessageQueueStore } from "@/stores/messageQueueStore"
import { flushQueuedMessagesForSession, isQueuedMessageFlushInFlight } from "./queuedSend"

const createAttachment = (filename: string): AttachedFile => ({
  id: filename,
  file: new File(["content"], filename, { type: "text/plain" }),
  dataUrl: `data:text/plain,${filename}`,
  mimeType: "text/plain",
  filename,
  size: filename.length,
  source: "local",
})

describe("queued message flushing", () => {
  beforeEach(() => {
    useMessageQueueStore.setState({ queuedMessages: {}, queueModeEnabled: true })
  })

  test("sends claimed queued messages as sequential turns with captured config", async () => {
    const sends: Array<Record<string, unknown>> = []

    useMessageQueueStore.getState().addToQueue("session-a", {
      content: "first queued",
      sendConfig: {
        providerID: "provider-first",
        modelID: "model-first",
        agent: "builder",
        variant: "fast",
        planMode: true,
      },
    })
    useMessageQueueStore.getState().addToQueue("session-a", {
      content: "second queued",
      attachments: [createAttachment("second.txt")],
      sendConfig: {
        providerID: "provider-second",
        modelID: "model-second",
        agent: "reviewer",
        variant: "careful",
        planMode: false,
      },
    })

    const sentCount = await flushQueuedMessagesForSession({
      sessionId: "session-a",
      fallbackSendConfig: {
        providerID: "provider-fallback",
        modelID: "model-fallback",
      },
      prepareQueuedMessage: (message, sendConfig) => ({
        content: message.content,
        attachments: message.attachments,
        providerID: sendConfig.providerID,
        modelID: sendConfig.modelID,
        agent: sendConfig.agent,
        variant: sendConfig.variant,
        planMode: sendConfig.planMode,
      }),
      sendMessageToSession: async (...args) => {
        const [
          sessionId,
          content,
          providerID,
          modelID,
          agent,
          attachments,
          agentMentionName,
          additionalParts,
          variant,
          inputMode,
          planMode,
        ] = args
        sends.push({
          sessionId,
          content,
          providerID,
          modelID,
          agent,
          attachments,
          agentMentionName,
          additionalParts,
          variant,
          inputMode,
          planMode,
        })
      },
      waitForReadyToSendNext: async () => {},
    })

    expect(sentCount).toBe(2)
    expect(sends).toEqual([
      {
        sessionId: "session-a",
        content: "first queued",
        providerID: "provider-first",
        modelID: "model-first",
        agent: "builder",
        attachments: undefined,
        agentMentionName: undefined,
        additionalParts: undefined,
        variant: "fast",
        inputMode: "normal",
        planMode: true,
      },
      {
        sessionId: "session-a",
        content: "second queued",
        providerID: "provider-second",
        modelID: "model-second",
        agent: "reviewer",
        attachments: [createAttachment("second.txt")],
        agentMentionName: undefined,
        additionalParts: undefined,
        variant: "careful",
        inputMode: "normal",
        planMode: false,
      },
    ])
    expect(useMessageQueueStore.getState().getQueueForSession("session-a")).toEqual([])
  })

  test("restores every queued message when the first sequential send fails", async () => {
    useMessageQueueStore.getState().addToQueue("session-a", { content: "first queued" })
    useMessageQueueStore.getState().addToQueue("session-a", { content: "second queued" })

    let error: unknown
    try {
      await flushQueuedMessagesForSession({
        sessionId: "session-a",
        fallbackSendConfig: {
          providerID: "provider-a",
          modelID: "model-a",
        },
        prepareQueuedMessage: (message, sendConfig) => ({
          content: message.content,
          providerID: sendConfig.providerID,
          modelID: sendConfig.modelID,
        }),
        sendMessageToSession: async () => {
          throw new Error("send failed")
        },
        waitForReadyToSendNext: async () => {},
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("send failed")
    expect(useMessageQueueStore.getState().getQueueForSession("session-a").map((message) => message.content)).toEqual([
      "first queued",
      "second queued",
    ])
  })

  test("restores only unsent queued messages after a later send fails", async () => {
    const sends: string[] = []
    useMessageQueueStore.getState().addToQueue("session-a", { content: "first queued" })
    useMessageQueueStore.getState().addToQueue("session-a", { content: "second queued" })
    useMessageQueueStore.getState().addToQueue("session-a", { content: "third queued" })

    let error: unknown
    try {
      await flushQueuedMessagesForSession({
        sessionId: "session-a",
        fallbackSendConfig: {
          providerID: "provider-a",
          modelID: "model-a",
        },
        prepareQueuedMessage: (message, sendConfig) => ({
          content: message.content,
          providerID: sendConfig.providerID,
          modelID: sendConfig.modelID,
        }),
        sendMessageToSession: async (_sessionId, content) => {
          sends.push(content)
          if (content === "second queued") {
            throw new Error("send failed")
          }
        },
        waitForReadyToSendNext: async () => {},
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("send failed")

    expect(sends).toEqual(["first queued", "second queued"])
    expect(useMessageQueueStore.getState().getQueueForSession("session-a").map((message) => message.content)).toEqual([
      "second queued",
      "third queued",
    ])
  })

  test("uses the original queued session even when another session is current", async () => {
    const targetSessionIds: string[] = []
    useMessageQueueStore.getState().addToQueue("session-a", { content: "queued for A" })
    useMessageQueueStore.getState().addToQueue("session-b", { content: "queued for B" })

    await flushQueuedMessagesForSession({
      sessionId: "session-a",
      fallbackSendConfig: {
        providerID: "provider-a",
        modelID: "model-a",
      },
      prepareQueuedMessage: (message, sendConfig) => ({
        content: message.content,
        providerID: sendConfig.providerID,
        modelID: sendConfig.modelID,
      }),
      sendMessageToSession: async (sessionId) => {
        targetSessionIds.push(sessionId)
      },
      waitForReadyToSendNext: async () => {},
    })

    expect(targetSessionIds).toEqual(["session-a"])
    expect(useMessageQueueStore.getState().getQueueForSession("session-a")).toEqual([])
    expect(useMessageQueueStore.getState().getQueueForSession("session-b").map((message) => message.content)).toEqual([
      "queued for B",
    ])
  })

  test("waits for each queued turn before sending the next queued message", async () => {
    const operations: string[] = []
    useMessageQueueStore.getState().addToQueue("session-a", { content: "first queued" })
    useMessageQueueStore.getState().addToQueue("session-a", { content: "second queued" })

    await flushQueuedMessagesForSession({
      sessionId: "session-a",
      fallbackSendConfig: {
        providerID: "provider-a",
        modelID: "model-a",
      },
      prepareQueuedMessage: (message, sendConfig) => ({
        content: message.content,
        providerID: sendConfig.providerID,
        modelID: sendConfig.modelID,
      }),
      sendMessageToSession: async (_sessionId, content) => {
        operations.push(`send:${content}`)
      },
      waitForReadyToSendNext: async () => {
        operations.push("wait")
      },
    })

    expect(operations).toEqual([
      "send:first queued",
      "wait",
      "send:second queued",
    ])
  })

  test("keeps claimed queue ownership visible until every claimed turn settles", async () => {
    useMessageQueueStore.getState().addToQueue("session-a", { content: "first queued" })
    useMessageQueueStore.getState().addToQueue("session-a", { content: "second queued" })

    let releaseWait!: () => void
    const waiting = new Promise<void>((resolve) => {
      releaseWait = resolve
    })
    const flush = flushQueuedMessagesForSession({
      sessionId: "session-a",
      fallbackSendConfig: { providerID: "provider-a", modelID: "model-a" },
      prepareQueuedMessage: (message, sendConfig) => ({
        content: message.content,
        providerID: sendConfig.providerID,
        modelID: sendConfig.modelID,
      }),
      sendMessageToSession: async () => {},
      waitForReadyToSendNext: () => waiting,
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(useMessageQueueStore.getState().getQueueForSession("session-a")).toEqual([])
    expect(isQueuedMessageFlushInFlight("session-a")).toBe(true)

    releaseWait()
    await flush
    expect(isQueuedMessageFlushInFlight("session-a")).toBe(false)
  })
})
