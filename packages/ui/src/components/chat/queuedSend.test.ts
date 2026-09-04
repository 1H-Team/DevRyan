import { beforeEach, describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import type { AttachedFile } from "@/stores/types/sessionTypes"
import { useMessageQueueStore } from "@/stores/messageQueueStore"
import {
  dispatchQueuedMessageForSession,
  flushQueuedMessagesForSession,
  hasCompletedQueuedTurn,
  isQueuedMessageFlushInFlight,
  sendQueuedMessagesNowForSession,
  waitForQueuedTurnIdle,
} from "./queuedSend"

const nextTick = (): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, 0)
})

const createAttachment = (filename: string): AttachedFile => ({
  id: filename,
  file: new File(["content"], filename, { type: "text/plain" }),
  dataUrl: `data:text/plain,${filename}`,
  mimeType: "text/plain",
  filename,
  size: filename.length,
  source: "local",
})

const assistantMessage = (
  id: string,
  parentID: string,
  completed?: number,
  finish?: string,
): Message => ({
  id,
  sessionID: "session-a",
  role: "assistant",
  parentID,
  time: completed ? { created: 1, completed } : { created: 1 },
  finish,
} as Message)

describe("queued message flushing", () => {
  beforeEach(() => {
    useMessageQueueStore.setState({ queuedMessages: {}, queueModeEnabled: true })
  })

  test("sends claimed queued messages as sequential turns with captured config", async () => {
    const sends: Array<Record<string, unknown>> = []

    useMessageQueueStore.getState().addToQueue("session-a", {
      content: "first queued",
      directory: "/repo/at-queue-time",
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
    const queuedRows = useMessageQueueStore.getState().getQueueForSession("session-a")
    expect(queuedRows.map((message) => message.id)).toHaveLength(2)
    expect(queuedRows.map((message) => message.messageId)).toEqual([undefined, undefined])

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
          lifecycleCallbacks,
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
          messageID: lifecycleCallbacks?.messageID,
          directory: lifecycleCallbacks?.directory,
        })
      },
      waitForReadyToSendNext: async () => {},
    })

    expect(sentCount).toBe(2)
    const dispatchedMessageIds = sends.map((send) => send.messageID as string)
    expect(dispatchedMessageIds[0]?.startsWith("msg_")).toBe(true)
    expect(dispatchedMessageIds[1]?.startsWith("msg_")).toBe(true)
    expect(dispatchedMessageIds[0]).not.toBe(dispatchedMessageIds[1])
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
        messageID: dispatchedMessageIds[0],
        directory: "/repo/at-queue-time",
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
        messageID: dispatchedMessageIds[1],
        directory: undefined,
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
    const restoredQueue = useMessageQueueStore.getState().getQueueForSession("session-a")
    expect(restoredQueue.map((message) => message.content)).toEqual([
      "first queued",
      "second queued",
    ])
    expect(restoredQueue[0]?.messageId?.startsWith("msg_")).toBe(true)
    expect(restoredQueue[0]?.messageIdScope).toBe("dispatch")
    expect(restoredQueue[1]?.messageId).toBe(undefined)
  })

  test("retries one manually dispatched row with the same identity after an ambiguous failure", async () => {
    useMessageQueueStore.getState().addToQueue("session-a", { content: "queued before" })
    useMessageQueueStore.getState().addToQueue("session-a", {
      content: "accepted before the response was lost",
      directory: "/repo/queued",
    })
    useMessageQueueStore.getState().addToQueue("session-a", { content: "queued after" })
    const original = useMessageQueueStore.getState().getQueueForSession("session-a")[1]
    const observedMessageIds: Array<string | undefined> = []
    let createdMessageIdCount = 0
    const createMessageId = () => {
      createdMessageIdCount += 1
      return `msg_dispatch_${createdMessageIdCount}`
    }

    let firstError: unknown
    try {
      await dispatchQueuedMessageForSession({
        sessionId: "session-a",
        queuedMessageId: original.id,
        createMessageId,
        dispatch: async (message) => {
          observedMessageIds.push(message.messageId)
          throw new Error("response lost after acceptance")
        },
      })
    } catch (error) {
      firstError = error
    }

    expect(firstError instanceof Error ? firstError.message : "").toBe("response lost after acceptance")
    const restoredQueue = useMessageQueueStore.getState().getQueueForSession("session-a")
    expect(restoredQueue.map((message) => message.content)).toEqual([
      "queued before",
      "accepted before the response was lost",
      "queued after",
    ])
    const restored = restoredQueue[1]
    expect(restored.id).toBe(original.id)
    expect(restored.createdAt).toBe(original.createdAt)
    expect(restored.messageId).toBe("msg_dispatch_1")
    expect(restored.messageIdScope).toBe("dispatch")
    expect(restored.directory).toBe("/repo/queued")

    const dispatched = await dispatchQueuedMessageForSession({
      sessionId: "session-a",
      queuedMessageId: restored.id,
      createMessageId,
      dispatch: async (message) => {
        observedMessageIds.push(message.messageId)
      },
    })

    expect(dispatched).toBe(true)
    expect(observedMessageIds).toEqual(["msg_dispatch_1", "msg_dispatch_1"])
    expect(createdMessageIdCount).toBe(1)
    expect(useMessageQueueStore.getState().getQueueForSession("session-a").map((message) => message.content)).toEqual([
      "queued before",
      "queued after",
    ])
  })

  test("lets only one sender claim a manually dispatched queue row", async () => {
    useMessageQueueStore.getState().addToQueue("session-a", { content: "send once" })
    const original = useMessageQueueStore.getState().getQueueForSession("session-a")[0]
    let releaseFirstDispatch!: () => void
    const firstDispatchPending = new Promise<void>((resolve) => {
      releaseFirstDispatch = resolve
    })
    let dispatchCount = 0

    const firstDispatch = dispatchQueuedMessageForSession({
      sessionId: "session-a",
      queuedMessageId: original.id,
      createMessageId: () => "msg_dispatch_once",
      dispatch: async () => {
        dispatchCount += 1
        await firstDispatchPending
      },
    })
    await Promise.resolve()

    const secondDispatch = await dispatchQueuedMessageForSession({
      sessionId: "session-a",
      queuedMessageId: original.id,
      createMessageId: () => "msg_dispatch_duplicate",
      dispatch: async () => {
        dispatchCount += 1
      },
    })

    expect(secondDispatch).toBe(false)
    expect(dispatchCount).toBe(1)
    releaseFirstDispatch()
    expect(await firstDispatch).toBe(true)
  })

  test("restores a manually claimed row when dispatch identity creation fails", async () => {
    useMessageQueueStore.getState().addToQueue("session-a", { content: "preserve on identity failure" })
    const original = useMessageQueueStore.getState().getQueueForSession("session-a")[0]

    let failure: unknown
    try {
      await dispatchQueuedMessageForSession({
        sessionId: "session-a",
        queuedMessageId: original.id,
        createMessageId: () => {
          throw new Error("identity unavailable")
        },
        dispatch: async () => {
          throw new Error("dispatch must not run")
        },
      })
    } catch (error) {
      failure = error
    }

    expect(failure instanceof Error ? failure.message : "").toBe("identity unavailable")
    expect(useMessageQueueStore.getState().getQueueForSession("session-a")).toEqual([original])
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
    const restoredQueue = useMessageQueueStore.getState().getQueueForSession("session-a")
    expect(restoredQueue.map((message) => message.content)).toEqual([
      "second queued",
      "third queued",
    ])
    expect(restoredQueue[0]?.messageId?.startsWith("msg_")).toBe(true)
    expect(restoredQueue[0]?.messageIdScope).toBe("dispatch")
    expect(restoredQueue[1]?.messageId).toBe(undefined)
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
    let dispatchPhase = "before-first-wait"
    const generatedAt: string[] = []
    let generatedId = 0
    useMessageQueueStore.getState().addToQueue("session-a", {
      content: "first queued",
      directory: "/repo/queued",
    })
    useMessageQueueStore.getState().addToQueue("session-a", { content: "second queued" })
    let firstMessageId: string | undefined

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
      createMessageId: () => {
        generatedAt.push(dispatchPhase)
        generatedId += 1
        return `msg_dispatch_${generatedId}`
      },
      waitForReadyToSendNext: async (sessionId, messageId, directory) => {
        firstMessageId = messageId
        operations.push(`wait:${sessionId}:${messageId}:${directory}`)
        dispatchPhase = "after-first-wait"
      },
    })

    expect(firstMessageId?.startsWith("msg_")).toBe(true)
    expect(generatedAt).toEqual(["before-first-wait", "after-first-wait"])
    expect(operations).toEqual([
      "send:first queued",
      `wait:session-a:${firstMessageId}:/repo/queued`,
      "send:second queued",
    ])
  })

  test("waits for the current correlated turn before the first natural auto-send", async () => {
    const operations: string[] = []
    useMessageQueueStore.getState().addToQueue("session-a", {
      content: "first queued",
      directory: "/repo/queued",
    })
    useMessageQueueStore.getState().addToQueue("session-a", { content: "second queued" })
    let firstQueuedMessageId: string | undefined

    await flushQueuedMessagesForSession({
      sessionId: "session-a",
      waitForCurrentTurnBeforeFirstSend: true,
      getCurrentTurnContext: () => ({
        messageId: "active-user-message",
        directory: "/repo/active",
      }),
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
      waitForReadyToSendNext: async (_sessionId, messageId, directory) => {
        if (messageId !== "active-user-message") {
          firstQueuedMessageId = messageId
        }
        operations.push(`wait:${messageId}:${directory}`)
      },
    })

    expect(firstQueuedMessageId?.startsWith("msg_")).toBe(true)
    expect(operations).toEqual([
      "wait:active-user-message:/repo/active",
      "send:first queued",
      `wait:${firstQueuedMessageId}:/repo/queued`,
      "send:second queued",
    ])
  })

  test("settles only from a completed assistant message correlated to the queued user turn", () => {
    const parts = new Map<string, Part[]>([
      ["assistant-tool", [{
        id: "part-tool",
        sessionID: "session-a",
        messageID: "assistant-tool",
        type: "tool",
        callID: "call-1",
        tool: "read",
        state: { status: "running", input: {}, time: { start: 1 } },
      } as Part]],
    ])
    const getParts = (messageId: string) => parts.get(messageId) ?? []

    expect(hasCompletedQueuedTurn([
      assistantMessage("assistant-wrong-parent", "other-user", 2, "stop"),
      assistantMessage("assistant-incomplete", "queued-user"),
      assistantMessage("assistant-tool", "queued-user", 2, "tool-calls"),
    ], getParts, "queued-user")).toBe(false)

    expect(hasCompletedQueuedTurn([
      assistantMessage("assistant-complete", "queued-user", 3, "stop"),
    ], getParts, "queued-user")).toBe(true)
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

  test("steers in the background: the first send is inserted at click time and posts once the gate settles", async () => {
    const operations: string[] = []
    useMessageQueueStore.getState().addToQueue("session-a", { content: "first queued" })
    useMessageQueueStore.getState().addToQueue("session-a", { content: "second queued" })
    let settleInterrupt: () => void = () => {}
    const gateSeenBy: string[] = []

    const sentCount = await sendQueuedMessagesNowForSession({
      sessionId: "session-a",
      interruptBeforeFlush: true,
      beginInterrupt: (sessionId) => {
        operations.push(`steer:${sessionId}`)
        const gate = new Promise<void>((resolve) => {
          settleInterrupt = () => {
            operations.push("steer-settled")
            resolve()
          }
        })
        return () => gate
      },
      fallbackSendConfig: { providerID: "provider-a", modelID: "model-a" },
      prepareQueuedMessage: (message, sendConfig) => ({
        content: message.content,
        providerID: sendConfig.providerID,
        modelID: sendConfig.modelID,
      }),
      sendMessageToSession: async (_sessionId, content, ...rest) => {
        const lifecycle = rest[rest.length - 1] as { awaitTransportGate?: () => Promise<void> } | undefined
        // Optimistic insert happens before the interrupt resolves.
        operations.push(`insert:${content}`)
        if (lifecycle?.awaitTransportGate) {
          gateSeenBy.push(content)
          // Let the interrupt settle only after the insert was observed.
          void nextTick().then(() => settleInterrupt())
          await lifecycle.awaitTransportGate()
        }
        operations.push(`post:${content}`)
      },
      waitForReadyToSendNext: async () => {
        operations.push("wait-idle")
      },
    })

    expect(sentCount).toBe(2)
    expect(operations).toEqual([
      "steer:session-a",
      "insert:first queued",
      "steer-settled",
      "post:first queued",
      "wait-idle",
      "insert:second queued",
      "post:second queued",
    ])
    // Only the first message posts through the gate; later ones wait on idle only.
    expect(gateSeenBy).toEqual(["first queued"])
    expect(useMessageQueueStore.getState().getQueueForSession("session-a")).toEqual([])
  })

  test("restores the whole queue when the steered interrupt fails", async () => {
    useMessageQueueStore.getState().addToQueue("session-a", { content: "still queued" })
    useMessageQueueStore.getState().addToQueue("session-a", { content: "also still queued" })
    const posted: string[] = []

    let error: unknown
    try {
      await sendQueuedMessagesNowForSession({
        sessionId: "session-a",
        interruptBeforeFlush: true,
        beginInterrupt: () => {
          const gate = Promise.reject(new Error("Session abort timed out"))
          gate.catch(() => {})
          return () => gate
        },
        fallbackSendConfig: { providerID: "provider-a", modelID: "model-a" },
        prepareQueuedMessage: (message, sendConfig) => ({
          content: message.content,
          providerID: sendConfig.providerID,
          modelID: sendConfig.modelID,
        }),
        sendMessageToSession: async (_sessionId, content, ...rest) => {
          const lifecycle = rest[rest.length - 1] as { awaitTransportGate?: () => Promise<void> } | undefined
          await lifecycle?.awaitTransportGate?.()
          posted.push(content)
        },
      })
    } catch (caught) {
      error = caught
    }

    expect(error instanceof Error ? error.message : "").toBe("Session abort timed out")
    expect(posted).toEqual([])
    expect(useMessageQueueStore.getState().getQueueForSession("session-a").map((message) => message.content)).toEqual([
      "still queued",
      "also still queued",
    ])
  })

  test("does not start the interrupt when no steering is needed", async () => {
    useMessageQueueStore.getState().addToQueue("session-a", { content: "queued" })
    let interruptStarted = false
    let lifecycleSeen: { awaitTransportGate?: () => Promise<void> } | undefined

    await sendQueuedMessagesNowForSession({
      sessionId: "session-a",
      interruptBeforeFlush: false,
      beginInterrupt: () => {
        interruptStarted = true
        return () => Promise.resolve()
      },
      fallbackSendConfig: { providerID: "provider-a", modelID: "model-a" },
      prepareQueuedMessage: (message, sendConfig) => ({
        content: message.content,
        providerID: sendConfig.providerID,
        modelID: sendConfig.modelID,
      }),
      sendMessageToSession: async (_sessionId, _content, ...rest) => {
        lifecycleSeen = rest[rest.length - 1] as typeof lifecycleSeen
      },
    })

    expect(interruptStarted).toBe(false)
    expect(lifecycleSeen?.awaitTransportGate).toBe(undefined)
  })

  test("waitForQueuedTurnIdle returns at once for an idle session instead of pre-waiting for busy", async () => {
    const startedAt = Date.now()
    await waitForQueuedTurnIdle("session-never-busy")
    expect(Date.now() - startedAt).toBeLessThan(1_000)
  })

  test("authorizes each captured agent at dispatch time and restores blocked Builder work", async () => {
    useMessageQueueStore.getState().addToQueue("session-a", {
      content: "safe orchestrator item",
      sendConfig: { providerID: "provider-a", modelID: "model-a", agent: "Orchestrator" },
    })
    useMessageQueueStore.getState().addToQueue("session-a", {
      content: "blocked builder item",
      sendConfig: { providerID: "provider-a", modelID: "model-a", agent: "Builder" },
    })
    const sent: string[] = []
    const authorized: Array<string | null | undefined> = []

    let failureMessage = ""
    try {
      await flushQueuedMessagesForSession({
        sessionId: "session-a",
        fallbackSendConfig: { providerID: "provider-a", modelID: "model-a" },
        authorizeSend: async ({ agentName }) => {
          authorized.push(agentName)
          return agentName?.toLowerCase() !== "builder"
        },
        prepareQueuedMessage: (message, sendConfig) => ({
          content: message.content,
          providerID: sendConfig.providerID,
          modelID: sendConfig.modelID,
          agent: sendConfig.agent,
        }),
        sendMessageToSession: async (_sessionId, content) => {
          sent.push(content)
        },
        waitForReadyToSendNext: async () => undefined,
      })
    } catch (error) {
      failureMessage = error instanceof Error ? error.message : String(error)
    }
    expect(failureMessage).toBe("Queued send requires agent handoff confirmation")

    expect(authorized).toEqual(["Orchestrator", "Builder"])
    expect(sent).toEqual(["safe orchestrator item"])
    expect(useMessageQueueStore.getState().getQueueForSession("session-a").map((message) => message.content)).toEqual([
      "blocked builder item",
    ])
  })
})
