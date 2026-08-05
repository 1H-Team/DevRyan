import { beforeEach, describe, expect, test } from "bun:test"
import {
  getResponsivenessPerfSnapshot,
  postRendererTurnTimingMark,
  postTurnTimingMark,
  responsivenessPerfObserve,
  resetStreamPerf,
  setStreamPerfEnabled,
} from "./streamDebug"
import { getSafeStorage } from "./safeStorage"

const storage = new Map<string, string>()

const installWindow = () => {
  storage.clear()
  const mockWindow = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value)
      },
      removeItem: (key: string) => {
        storage.delete(key)
      },
    },
  } as unknown as Window

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: mockWindow,
  })
}

describe("stream responsiveness diagnostics", () => {
  beforeEach(() => {
    installWindow()
    globalThis.fetch = undefined as unknown as typeof fetch
  })

  test("does not collect responsiveness metrics when stream perf is disabled", () => {
    responsivenessPerfObserve("event_pipeline.flush_ms", 12)

    expect(getResponsivenessPerfSnapshot()).toEqual({
      enabled: false,
      startedAt: null,
      lastUpdatedAt: null,
      durationMs: 0,
      entries: [],
    })
  })

  test("enabling stream perf initializes responsiveness diagnostics", () => {
    setStreamPerfEnabled(true)
    responsivenessPerfObserve("event_pipeline.flush_ms", 12)

    const snapshot = getResponsivenessPerfSnapshot()
    expect(snapshot.enabled).toBe(true)
    expect(typeof snapshot.startedAt).toBe("number")
    expect(typeof snapshot.lastUpdatedAt).toBe("number")
    expect(snapshot.entries).toEqual([
      {
        metric: "responsiveness.event_pipeline.flush_ms",
        count: 1,
        avg: 12,
        max: 12,
        total: 12,
        last: 12,
      },
    ])
  })

  test("reset clears responsiveness counters", () => {
    setStreamPerfEnabled(true)
    responsivenessPerfObserve("event_pipeline.flush_ms", 12)

    resetStreamPerf()

    expect(getResponsivenessPerfSnapshot().entries).toEqual([])
  })

  test("responsiveness snapshot entries sort by total time", () => {
    setStreamPerfEnabled(true)
    responsivenessPerfObserve("sync.apply.message.part.delta.ms", 3)
    responsivenessPerfObserve("event_pipeline.flush_ms", 12)
    responsivenessPerfObserve("sync.apply.message.part.delta.ms", 4)

    expect(getResponsivenessPerfSnapshot().entries.map((entry) => entry.metric)).toEqual([
      "responsiveness.event_pipeline.flush_ms",
      "responsiveness.sync.apply.message.part.delta.ms",
    ])
  })

  test("posts backend turn timing marks only when stream debug is enabled", () => {
    const calls: Array<{ url: string; body: unknown }> = []
    globalThis.fetch = ((url, init) => {
      calls.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      return Promise.resolve(Response.json({ ok: true }))
    }) as typeof fetch

    postTurnTimingMark({
      sessionId: "ses_1",
      messageId: "msg_1",
      mark: "send_started",
      directory: "/project",
    })
    expect(calls).toEqual([])

    getSafeStorage().setItem("openchamber_stream_debug", "1")
    postTurnTimingMark({
      sessionId: "ses_1",
      messageId: "msg_1",
      mark: "send_started",
      directory: "/project",
      metadata: { inputMode: "normal" },
    })

    expect(calls).toEqual([
      {
        url: "/api/diagnostics/turn-timing/mark",
        body: {
          sessionId: "ses_1",
          messageId: "msg_1",
          mark: "send_started",
          directory: "/project",
          metadata: { inputMode: "normal" },
        },
      },
    ])
  })

  test("posts renderer timing marks without prompt or response text", () => {
    const calls: Array<{ url: string; body: unknown }> = []
    globalThis.fetch = ((url, init) => {
      calls.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      return Promise.resolve(Response.json({ ok: true }))
    }) as typeof fetch

    getSafeStorage().setItem("openchamber_stream_debug", "1")
    postRendererTurnTimingMark({
      sessionId: "ses_1",
      assistantMessageId: "msg_assistant",
      mark: "renderer_event_received",
      directory: "/project",
      metadata: {
        runtime: "desktop",
        transport: "ws",
        visibilityState: "visible",
        prompt: "secret prompt",
        text: "secret response",
        delta: "secret token",
      },
    })

    expect(calls).toEqual([
      {
        url: "/api/diagnostics/turn-timing/mark",
        body: {
          sessionId: "ses_1",
          assistantMessageId: "msg_assistant",
          mark: "renderer_event_received",
          directory: "/project",
          metadata: {
            runtime: "desktop",
            transport: "ws",
            visibilityState: "visible",
          },
        },
      },
    ])
  })

  test("records a confirmed tool-input stall even when stream debug is disabled", () => {
    const calls: Array<{ url: string; body: unknown }> = []
    globalThis.fetch = ((url, init) => {
      calls.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      return Promise.resolve(Response.json({ ok: true }))
    }) as typeof fetch

    postRendererTurnTimingMark({
      sessionId: "ses_1",
      assistantMessageId: "msg_assistant",
      mark: "renderer_tool_input_stall_confirmed",
      directory: "/project",
      metadata: { source: "active-session-watchdog" },
    })

    expect(calls).toEqual([{
      url: "/api/diagnostics/turn-timing/mark",
      body: {
        sessionId: "ses_1",
        assistantMessageId: "msg_assistant",
        mark: "renderer_tool_input_stall_confirmed",
        directory: "/project",
        metadata: { source: "active-session-watchdog" },
      },
    }])
  })

  test("records a confirmed inference stall with sanitized duration when stream debug is disabled", () => {
    const calls: Array<{ url: string; body: unknown }> = []
    globalThis.fetch = ((url, init) => {
      calls.push({
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })
      return Promise.resolve(Response.json({ ok: true }))
    }) as typeof fetch

    postRendererTurnTimingMark({
      sessionId: "ses_1",
      assistantMessageId: "msg_assistant",
      mark: "renderer_provider_inference_stall_confirmed",
      directory: "/project",
      metadata: {
        source: "active-session-watchdog",
        stalledForMs: 300_123.9,
        text: "secret response",
      },
    })

    expect(calls).toEqual([{
      url: "/api/diagnostics/turn-timing/mark",
      body: {
        sessionId: "ses_1",
        assistantMessageId: "msg_assistant",
        mark: "renderer_provider_inference_stall_confirmed",
        directory: "/project",
        metadata: {
          source: "active-session-watchdog",
          stalledForMs: 300_123,
        },
      },
    }])
  })
})
