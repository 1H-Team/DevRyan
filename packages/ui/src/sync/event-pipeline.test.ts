import { describe, expect, test } from "bun:test"
import type { Event as OpencodeEvent, OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { coalescePartDeltaValue, createEventPipeline } from "./event-pipeline"

const originalWindow = globalThis.window
const originalWebSocket = globalThis.WebSocket
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator")

const failAfter = (ms: number) => new Promise<never>((_, reject) => {
  setTimeout(() => reject(new Error("Timed out waiting for event pipeline flush")), ms)
})

function partUpdatedEvent(text: string): OpencodeEvent {
  return {
    type: "message.part.updated",
    properties: {
      part: {
        id: "prt_1",
        messageID: "msg_1",
        sessionID: "ses_1",
        type: "text",
        text,
      },
    },
  } as OpencodeEvent
}

function deltaEvent(delta: string): OpencodeEvent {
  return {
    type: "message.part.delta",
    properties: {
      messageID: "msg_1",
      partID: "prt_1",
      field: "text",
      delta,
    },
  } as OpencodeEvent
}

function syntheticStatusEvent(sessionId: string, status: "idle" | "busy" | "retry", metadata: Record<string, unknown> = {}): OpencodeEvent {
  return {
    type: "openchamber:session-status",
    properties: {
      sessionId,
      status,
      timestamp: 100,
      metadata,
      needsAttention: false,
    },
  } as unknown as OpencodeEvent
}

function createSdk(events: OpencodeEvent[], streamFinished: () => void): OpencodeClient {
  return {
    global: {
      event: async ({ signal }: { signal: AbortSignal }) => ({
        stream: (async function* () {
          for (const payload of events) {
            yield { directory: "/repo", payload }
          }
          streamFinished()
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve()
              return
            }
            signal.addEventListener("abort", () => resolve(), { once: true })
          })
        })(),
      }),
    },
  } as unknown as OpencodeClient
}

class FakeWebSocket {
  static instances: FakeWebSocket[] = []

  url: string
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event?: { code?: number }) => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  close() {
    this.readyState = 3
  }

  emitClose(code = 1006) {
    this.readyState = 3
    this.onclose?.({ code })
  }
}

function installBrowserStubs(options: { isVSCode?: boolean } = {}) {
  globalThis.window = {
    location: {
      href: "http://127.0.0.1:5173/",
      origin: "http://127.0.0.1:5173",
    },
    __OPENCHAMBER_RUNTIME_APIS__: options.isVSCode
      ? { runtime: { platform: "vscode", isDesktop: false, isVSCode: true, label: "VS Code" } }
      : undefined,
    addEventListener() {},
    removeEventListener() {},
  } as unknown as Window & typeof globalThis
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
}

function restoreBrowserStubs() {
  globalThis.window = originalWindow
  globalThis.WebSocket = originalWebSocket
  if (originalNavigatorDescriptor) {
    Object.defineProperty(globalThis, "navigator", originalNavigatorDescriptor)
  } else {
    Reflect.deleteProperty(globalThis, "navigator")
  }
  FakeWebSocket.instances = []
}

function installRetryEventStubs(initialOnline = true) {
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()
  let online = initialOnline
  const getListeners = (type: string) => {
    let set = listeners.get(type)
    if (!set) {
      set = new Set()
      listeners.set(type, set)
    }
    return set
  }
  const windowStub = {
    location: {
      href: "http://127.0.0.1:5173/",
      origin: "http://127.0.0.1:5173",
    },
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      getListeners(type).add(listener)
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      listeners.get(type)?.delete(listener)
    },
    dispatchEvent(event: Event) {
      for (const listener of listeners.get(event.type) ?? []) {
        if (typeof listener === "function") {
          listener.call(windowStub, event)
        } else {
          listener.handleEvent(event)
        }
      }
      return true
    },
  }
  globalThis.window = windowStub as unknown as Window & typeof globalThis
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    get: () => ({ onLine: online }),
  })
  return {
    setOnline(value: boolean) {
      online = value
    },
    dispatch(type: string) {
      windowStub.dispatchEvent(new globalThis.Event(type))
    },
  }
}

describe("coalescePartDeltaValue", () => {
  test("normalizes duplicate coalesced text frames", () => {
    const frame = "Continuing implementation: creating the hook and history section, then wiring them into the shell."

    expect(coalescePartDeltaValue("text", frame, `\n${frame}\n`)).toBe(`${frame}\n`)
  })

  test("normalizes duplicate coalesced output frames", () => {
    const frame = 'Skipped malformed tool call "edit": Invalid arguments for tool "edit": missing required: old_string.'

    expect(coalescePartDeltaValue("output", frame, frame)).toBe(frame)
  })

  test("raw-appends non-text fields", () => {
    expect(coalescePartDeltaValue("other", "a", "a")).toBe("aa")
  })
})

describe("createEventPipeline", () => {
  test("routes managed orchestration events before directory queues", () => {
    const routed: unknown[] = []
    let directoryEvents = 0
    const pipeline = createEventPipeline({
      sdk: createSdk([], () => undefined),
      onEvent: () => {
        directoryEvents += 1
      },
      onManagedOrchestrationEvent: (event) => {
        routed.push(event)
      },
      transport: "sse",
      heartbeatTimeoutMs: 1_000,
    })
    const managedEvent = {
      type: "openchamber:managed-task",
      properties: {
        owner: "devryan",
        directory: "/repo",
        task: { taskId: "dvr_task_1" },
      },
    } as unknown as OpencodeEvent
    const removalEvent = {
      type: "openchamber:managed-task-removed",
      properties: {
        owner: "devryan",
        taskId: "dvr_task_1",
        rootSessionId: "ses_root",
        directory: "/repo",
        sequence: 1,
      },
    } as unknown as OpencodeEvent

    try {
      pipeline.enqueueEvent("/repo", managedEvent)
      pipeline.enqueueEvent("/repo", removalEvent)
      expect(routed).toEqual([managedEvent, removalEvent])
      expect(directoryEvents).toBe(0)
      expect(pipeline.getDirectoryQueueCount()).toBe(0)
    } finally {
      pipeline.cleanup()
    }
  })

  test("routes server-owned notification events before directory queues", () => {
    const routed: unknown[] = []
    let directoryEvents = 0
    const pipeline = createEventPipeline({
      sdk: createSdk([], () => undefined),
      onEvent: () => {
        directoryEvents += 1
      },
      onUserNotificationEvent: (event) => {
        routed.push(event)
      },
      transport: "sse",
      heartbeatTimeoutMs: 1_000,
    })
    const notificationEvent = {
      type: "openchamber:notification",
      properties: {
        kind: "plan-ready",
        title: "Plan ready",
        body: "A plan is ready for review",
        tag: "plan-ready-ses_1-plan_1",
      },
    } as unknown as OpencodeEvent

    try {
      pipeline.enqueueEvent("global", notificationEvent)
      expect(routed).toEqual([notificationEvent])
      expect(directoryEvents).toBe(0)
      expect(pipeline.getDirectoryQueueCount()).toBe(0)
    } finally {
      pipeline.cleanup()
    }
  })

  test("normalizes synthetic session status events into canonical session.status events", async () => {
    let resolveStreamFinished!: () => void
    const streamFinished = new Promise<void>((resolve) => {
      resolveStreamFinished = resolve
    })
    let resolveDelivered!: () => void
    const deliveredAll = new Promise<void>((resolve) => {
      resolveDelivered = resolve
    })
    const delivered: OpencodeEvent[] = []
    const pipeline = createEventPipeline({
      sdk: createSdk([
        syntheticStatusEvent("ses_1", "retry", {
          attempt: 2,
          message: "Retrying",
          next: 123,
        }),
      ], resolveStreamFinished),
      onEvent: (_directory, payload) => {
        delivered.push(payload)
        resolveDelivered()
      },
      transport: "sse",
      heartbeatTimeoutMs: 1_000,
    })

    try {
      await streamFinished
      await Promise.race([deliveredAll, failAfter(500)])
    } finally {
      pipeline.cleanup()
    }

    expect(delivered).toHaveLength(1)
    expect(delivered[0].type).toBe("session.status")
    const props = delivered[0].properties as {
      sessionID?: string
      status?: unknown
    }
    expect(props.sessionID).toBe("ses_1")
    expect(props.status).toEqual({
      type: "retry",
      attempt: 2,
      message: "Retrying",
      next: 123,
    })
  })

  test("releases empty per-directory queues after flush", async () => {
    let delivered = 0
    const pipeline = createEventPipeline({
      sdk: createSdk([], () => undefined),
      onEvent: () => {
        delivered += 1
      },
      transport: "sse",
      heartbeatTimeoutMs: 1_000,
    })

    try {
      for (let index = 0; index < 100; index += 1) {
        pipeline.enqueueEvent(`/repo/${index}`, partUpdatedEvent(String(index)))
      }
      await Promise.race([
        (async () => {
          while (delivered < 100) await new Promise((resolve) => setTimeout(resolve, 5))
        })(),
        failAfter(1_000),
      ])
      expect(pipeline.getDirectoryQueueCount()).toBe(0)
      expect(pipeline.getRecentDirectoryCount() <= 64).toBe(true)
    } finally {
      pipeline.cleanup()
    }
  })

  test("releaseDirectory drops queued events only for the released directory", async () => {
    let resolveStreamFinished!: () => void
    const pipeline = createEventPipeline({
      sdk: createSdk([], () => resolveStreamFinished?.()),
      onEvent: () => {
        throw new Error("Released event should not be delivered")
      },
      transport: "sse",
      heartbeatTimeoutMs: 1_000,
    })

    pipeline.enqueueEvent("/repo/released", partUpdatedEvent("pending"))
    expect(pipeline.getDirectoryQueueCount()).toBe(1)
    expect(pipeline.releaseDirectory("/repo/released")).toBe(true)
    expect(pipeline.getDirectoryQueueCount()).toBe(0)
    expect(pipeline.getRecentDirectoryCount()).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 50))
    pipeline.cleanup()
  })

  test("coalesces normalized synthetic status events by session", async () => {
    let resolveStreamFinished!: () => void
    const streamFinished = new Promise<void>((resolve) => {
      resolveStreamFinished = resolve
    })
    let resolveDelivered!: () => void
    const deliveredAll = new Promise<void>((resolve) => {
      resolveDelivered = resolve
    })
    const delivered: OpencodeEvent[] = []
    const pipeline = createEventPipeline({
      sdk: createSdk([
        syntheticStatusEvent("ses_1", "busy"),
        syntheticStatusEvent("ses_1", "idle"),
      ], resolveStreamFinished),
      onEvent: (_directory, payload) => {
        delivered.push(payload)
        resolveDelivered()
      },
      transport: "sse",
      heartbeatTimeoutMs: 1_000,
    })

    try {
      await streamFinished
      await Promise.race([deliveredAll, failAfter(500)])
    } finally {
      pipeline.cleanup()
    }

    expect(delivered).toHaveLength(1)
    expect(delivered[0].type).toBe("session.status")
    const props = delivered[0].properties as {
      sessionID?: string
      status?: unknown
    }
    expect(props.sessionID).toBe("ses_1")
    expect(props.status).toEqual({ type: "idle" })
  })

  test("preserves part update order around text deltas", async () => {
    let resolveStreamFinished!: () => void
    const streamFinished = new Promise<void>((resolve) => {
      resolveStreamFinished = resolve
    })
    let resolveDelivered!: () => void
    const deliveredAll = new Promise<void>((resolve) => {
      resolveDelivered = resolve
    })
    const delivered: OpencodeEvent[] = []
    const pipeline = createEventPipeline({
      sdk: createSdk([
        partUpdatedEvent("a"),
        deltaEvent("b"),
        partUpdatedEvent("ab"),
      ], resolveStreamFinished),
      onEvent: (_directory, payload) => {
        delivered.push(payload)
        if (delivered.length === 3) {
          resolveDelivered()
        }
      },
      transport: "sse",
      heartbeatTimeoutMs: 1_000,
    })

    try {
      await streamFinished
      await Promise.race([deliveredAll, failAfter(500)])
    } finally {
      pipeline.cleanup()
    }

    expect(delivered.map((event) => {
      if (event.type === "message.part.delta") {
        return `delta:${(event.properties as { delta: string }).delta}`
      }
      return `updated:${((event.properties as { part: { text: string } }).part).text}`
    })).toEqual(["updated:a", "delta:b", "updated:ab"])
  })

  test("does not coalesce a later delta behind an interleaved part snapshot", async () => {
    let resolveStreamFinished!: () => void
    const streamFinished = new Promise<void>((resolve) => {
      resolveStreamFinished = resolve
    })
    let resolveDelivered!: () => void
    const deliveredAll = new Promise<void>((resolve) => {
      resolveDelivered = resolve
    })
    const delivered: OpencodeEvent[] = []
    const pipeline = createEventPipeline({
      sdk: createSdk([
        deltaEvent("Hel"),
        partUpdatedEvent("Hel"),
        deltaEvent("lo"),
      ], resolveStreamFinished),
      onEvent: (_directory, payload) => {
        delivered.push(payload)
        if (delivered.length === 3) {
          resolveDelivered()
        }
      },
      transport: "sse",
      heartbeatTimeoutMs: 1_000,
    })

    try {
      await streamFinished
      await Promise.race([deliveredAll, failAfter(500)])
    } finally {
      pipeline.cleanup()
    }

    // The second delta must not coalesce into the first delta's slot ahead of
    // the snapshot — the stale snapshot would then overwrite it and drop "lo".
    expect(delivered.map((event) => {
      if (event.type === "message.part.delta") {
        return `delta:${(event.properties as { delta: string }).delta}`
      }
      return `updated:${((event.properties as { part: { text: string } }).part).text}`
    })).toEqual(["delta:Hel", "updated:Hel", "delta:lo"])
  })

  test("still coalesces consecutive deltas when no snapshot intervenes", async () => {
    let resolveStreamFinished!: () => void
    const streamFinished = new Promise<void>((resolve) => {
      resolveStreamFinished = resolve
    })
    let resolveDelivered!: () => void
    const deliveredAll = new Promise<void>((resolve) => {
      resolveDelivered = resolve
    })
    const delivered: OpencodeEvent[] = []
    const pipeline = createEventPipeline({
      sdk: createSdk([
        deltaEvent("Hel"),
        deltaEvent("lo"),
      ], resolveStreamFinished),
      onEvent: (_directory, payload) => {
        delivered.push(payload)
        resolveDelivered()
      },
      transport: "sse",
      heartbeatTimeoutMs: 1_000,
    })

    try {
      await streamFinished
      await Promise.race([deliveredAll, failAfter(500)])
    } finally {
      pipeline.cleanup()
    }

    expect(delivered).toHaveLength(1)
    expect((delivered[0].properties as { delta: string }).delta).toBe("Hello")
  })

  test("falls back from an initial auto WebSocket close to SSE without disconnecting", async () => {
    installBrowserStubs()

    let releaseStream!: () => void
    const streamHold = new Promise<void>((resolve) => {
      releaseStream = resolve
    })
    let sseStarted!: () => void
    const sseAttempted = new Promise<void>((resolve) => {
      sseStarted = resolve
    })

    const disconnectReasons: string[] = []
    let transportSwitchCount = 0
    let reconnectCount = 0

    const sdk = {
      global: {
        event: async () => {
          sseStarted()
          return {
            stream: (async function* () {
              yield {
                directory: "/repo",
                payload: { type: "server.connected", properties: {} } as OpencodeEvent,
              }
              await streamHold
            })(),
          }
        },
      },
    } as unknown as OpencodeClient

    const pipeline = createEventPipeline({
      sdk,
      transport: "auto",
      reconnectDelayMs: 0,
      wsReadyTimeoutMs: 100,
      heartbeatTimeoutMs: 1_000,
      onEvent: () => {},
      onDisconnect: (reason) => {
        disconnectReasons.push(reason)
      },
      onTransportSwitch: () => {
        transportSwitchCount += 1
      },
      onReconnect: () => {
        reconnectCount += 1
      },
    })

    try {
      await Promise.resolve()
      FakeWebSocket.instances[0]?.emitClose()
      await Promise.race([sseAttempted, failAfter(500)])
      await new Promise((resolve) => setTimeout(resolve, 20))
    } finally {
      pipeline.cleanup()
      releaseStream()
      restoreBrowserStubs()
    }

    expect(transportSwitchCount).toBe(1)
    expect(disconnectReasons).toEqual([])
    expect(reconnectCount).toBe(1)
  })

  test("does not report an SSE reconnect before the stream yields its first event", async () => {
    let rejectStream!: () => void
    const streamRejected = new Promise<void>((resolve) => {
      rejectStream = resolve
    })
    let disconnected!: () => void
    const disconnectedOnce = new Promise<void>((resolve) => {
      disconnected = resolve
    })
    let reconnectCount = 0
    const disconnectReasons: string[] = []
    const originalConsoleError = console.error
    console.error = () => {}

    const sdk = {
      global: {
        event: async () => ({
          stream: {
            [Symbol.asyncIterator]() {
              return {
                next: async () => {
                  rejectStream()
                  throw new Error("SSE failed: 500 Internal Server Error")
                },
              }
            },
          },
        }),
      },
    } as unknown as OpencodeClient

    const pipeline = createEventPipeline({
      sdk,
      transport: "sse",
      reconnectDelayMs: 1_000,
      heartbeatTimeoutMs: 1_000,
      onEvent: () => {},
      onDisconnect: (reason) => {
        disconnectReasons.push(reason)
        disconnected()
      },
      onReconnect: () => {
        reconnectCount += 1
      },
    })

    try {
      await Promise.race([streamRejected, failAfter(500)])
      await Promise.race([disconnectedOnce, failAfter(500)])
    } finally {
      pipeline.cleanup()
      console.error = originalConsoleError
    }

    expect(disconnectReasons).toEqual(["sse_error:SSE failed: 500 Internal Server Error"])
    expect(reconnectCount).toBe(0)
  })

  test("uses SSE directly for VS Code runtime auto transport", async () => {
    installBrowserStubs({ isVSCode: true })

    let releaseStream!: () => void
    const streamHold = new Promise<void>((resolve) => {
      releaseStream = resolve
    })
    let sseStarted!: () => void
    const sseAttempted = new Promise<void>((resolve) => {
      sseStarted = resolve
    })
    let reconnectCount = 0

    const sdk = {
      global: {
        event: async () => {
          sseStarted()
          return {
            stream: (async function* () {
              yield {
                directory: "/repo",
                payload: { type: "server.connected", properties: {} } as OpencodeEvent,
              }
              await streamHold
            })(),
          }
        },
      },
    } as unknown as OpencodeClient

    const pipeline = createEventPipeline({
      sdk,
      transport: "auto",
      reconnectDelayMs: 0,
      wsReadyTimeoutMs: 100,
      heartbeatTimeoutMs: 1_000,
      onEvent: () => {},
      onReconnect: () => {
        reconnectCount += 1
      },
    })

    try {
      await Promise.race([sseAttempted, failAfter(500)])
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(FakeWebSocket.instances).toHaveLength(0)
    } finally {
      pipeline.cleanup()
      releaseStream()
      restoreBrowserStubs()
    }

    expect(reconnectCount).toBe(1)
  })

  test("interrupts retry delay when the browser comes back online", async () => {
    const retryEvents = installRetryEventStubs(false)
    const originalConsoleError = console.error
    console.error = () => {}

    let attempts = 0
    let resolveSecondAttempt!: () => void
    let releaseStream!: () => void
    const secondAttempt = new Promise<void>((resolve) => {
      resolveSecondAttempt = resolve
    })
    const streamHold = new Promise<void>((resolve) => {
      releaseStream = resolve
    })
    const sdk = {
      global: {
        event: async () => {
          attempts += 1
          if (attempts === 1) {
            throw new TypeError("Failed to fetch")
          }
          resolveSecondAttempt()
          return {
            stream: (async function* () {
              yield* []
              await streamHold
            })(),
          }
        },
      },
    } as unknown as OpencodeClient

    const pipeline = createEventPipeline({
      sdk,
      transport: "sse",
      reconnectDelayMs: 500,
      heartbeatTimeoutMs: 1_000,
      onEvent: () => {},
    })

    try {
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(attempts).toBe(1)
      retryEvents.setOnline(true)
      retryEvents.dispatch("online")
      await Promise.race([secondAttempt, failAfter(150)])
    } finally {
      pipeline.cleanup()
      releaseStream?.()
      console.error = originalConsoleError
      restoreBrowserStubs()
    }

    expect(attempts).toBe(2)
  })

  test("paces permanent 4xx stream failures even with zero reconnect delay", async () => {
    installRetryEventStubs(true)
    const originalConsoleError = console.error
    console.error = () => {}
    let attempts = 0
    const sdk = {
      global: {
        event: async () => {
          attempts += 1
          throw Object.assign(new Error("not found"), { response: { status: 404 } })
        },
      },
    } as unknown as OpencodeClient

    const pipeline = createEventPipeline({
      sdk,
      transport: "sse",
      reconnectDelayMs: 0,
      heartbeatTimeoutMs: 1_000,
      onEvent: () => {},
    })

    try {
      await new Promise((resolve) => setTimeout(resolve, 80))
    } finally {
      pipeline.cleanup()
      console.error = originalConsoleError
      restoreBrowserStubs()
    }

    expect(attempts).toBe(1)
  })
})
