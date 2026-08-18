import { describe, expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2"
import {
  attachRelatedSubagentContextUsage,
  getContextUsageFromMessages,
  getProviderContextUsageFromMessages,
  getSubagentContextUsageForSession,
  isSameSessionContextUsage,
  type ContextUsageProviderLike,
} from "./contextUsageUtils"
import { resolveModelContextCapacity } from "./modelContextCapacity"

const makeMessage = (message: Record<string, unknown>): Message => message as unknown as Message
const capacity = (context: number) => resolveModelContextCapacity({ limit: { context } })

const providers: ContextUsageProviderLike[] = [
  { id: "provider-a", models: [{ id: "small", limit: { context: 1_000 } }] },
  {
    id: "provider-b",
    models: [{
      id: "large",
      limit: { context: 10_000 },
      variants: { high: { limit: { context: 20_000 } } },
    }],
  },
]

describe("getContextUsageFromMessages", () => {
  test("uses active input components instead of the provider cumulative total", () => {
    const usage = getContextUsageFromMessages([
      makeMessage({
        id: "assistant-1",
        role: "assistant",
        tokens: {
          total: 1_500,
          input: 1_000,
          output: 200,
          reasoning: 50,
          cache: { read: 10, write: 5 },
        },
      }),
    ], capacity(10_000))

    expect(usage?.activeInputTokens).toBe(1_015)
    expect(usage?.lastOutputTokens).toBe(200)
    expect(usage?.tokenBreakdown).toEqual({
      input: 1_000,
      output: 200,
      reasoning: 50,
      cacheRead: 10,
      cacheWrite: 5,
      total: 1_015,
    })
  })

  test("counts cache read and cache creation exactly once when no total is reported", () => {
    const usage = getContextUsageFromMessages([
      makeMessage({
        id: "assistant-1",
        role: "assistant",
        tokens: {
          input: 1_000,
          output: 200,
          reasoning: 50,
          cache: { read: 300, write: 25 },
        },
      }),
    ], capacity(10_000))

    expect(usage?.activeInputTokens).toBe(1_325)
    expect(usage?.percentage).toBe(13.25)
  })

  test("uses token data from a step-finish part when message tokens are absent", () => {
    const usage = getContextUsageFromMessages([{
      info: makeMessage({ id: "assistant-1", role: "assistant" }),
      parts: [{
        id: "part-1",
        type: "step-finish",
        tokens: { total: 900, input: 700, output: 125, reasoning: 75 },
      } as never],
    }], capacity(10_000))

    expect(usage?.activeInputTokens).toBe(700)
    expect(usage?.lastMessageId).toBe("assistant-1")
  })
})

describe("getProviderContextUsageFromMessages", () => {
  test("resolves capacity from the same newest token-bearing assistant message", () => {
    const usage = getProviderContextUsageFromMessages([
      makeMessage({
        id: "assistant-small",
        role: "assistant",
        providerID: "provider-a",
        modelID: "small",
        tokens: { total: 500 },
      }),
      makeMessage({
        id: "assistant-large",
        role: "assistant",
        providerID: "provider-b",
        modelID: "large",
        variant: "high",
        tokens: { total: 2_000 },
      }),
    ], providers)

    expect(usage?.lastMessageId).toBe("assistant-large")
    expect(usage?.capacityLimit).toBe(20_000)
    expect(usage?.percentage).toBe(10)
  })

  test("keeps measured tokens but makes capacity unavailable without message provenance", () => {
    const usage = getProviderContextUsageFromMessages([
      makeMessage({ id: "assistant-1", role: "assistant", tokens: { total: 500 } }),
    ], providers)

    expect(usage?.activeInputTokens).toBe(500)
    expect(usage?.capacityLimit).toBeNull()
    expect(usage?.capacityBasis).toBe("unavailable")
    expect(usage?.percentage).toBeNull()
  })

  test("skips newer zero-token assistant shells and preserves the completed measurement model", () => {
    const usage = getProviderContextUsageFromMessages([
      makeMessage({
        id: "assistant-complete",
        role: "assistant",
        providerID: "provider-a",
        modelID: "small",
        tokens: { total: 500 },
      }),
      makeMessage({
        id: "assistant-shell",
        role: "assistant",
        providerID: "provider-b",
        modelID: "large",
        tokens: { total: 0 },
      }),
    ], providers)

    expect(usage?.lastMessageId).toBe("assistant-complete")
    expect(usage?.capacityLimit).toBe(1_000)
    expect(usage?.percentage).toBe(50)
  })
})

describe("subagent context usage", () => {
  test("resolves every subagent against its own producing model", () => {
    const messages = new Map<string, Message[]>([
      ["child-small", [makeMessage({
        id: "assistant-small",
        role: "assistant",
        providerID: "provider-a",
        modelID: "small",
        tokens: { total: 500 },
      })]],
      ["child-large", [makeMessage({
        id: "assistant-large",
        role: "assistant",
        providerID: "provider-b",
        modelID: "large",
        tokens: { input: 1_000, cache: { read: 500, write: 0 } },
      })]],
    ])

    const related = getSubagentContextUsageForSession(
      "root",
      [
        { id: "root" },
        { id: "child-small", parentID: "root", title: "Small" },
        { id: "child-large", parentID: "child-small", title: "Large" },
        { id: "unloaded", parentID: "root", title: "Unloaded" },
      ],
      (sessionId) => messages.get(sessionId) ?? [],
      providers,
    )

    expect(related.activeInputTokens).toBe(2_000)
    expect(related.sessions.map((session) => ({
      id: session.sessionId,
      capacity: session.capacityLimit,
      percentage: session.percentage,
      parent: session.parentSessionId,
      depth: session.depth,
      hasData: session.hasData,
    }))).toEqual([
      { id: "child-small", capacity: 1_000, percentage: 50, parent: "root", depth: 0, hasData: true },
      { id: "unloaded", capacity: null, percentage: null, parent: "root", depth: 0, hasData: false },
      { id: "child-large", capacity: 10_000, percentage: 15, parent: "child-small", depth: 1, hasData: true },
    ])
  })

  test("attaches related usage without changing the parent measurement", () => {
    const parent = getContextUsageFromMessages([
      makeMessage({ id: "assistant-parent", role: "assistant", tokens: { total: 250 } }),
    ], capacity(1_000))
    if (!parent) throw new Error("expected parent usage")

    const attached = attachRelatedSubagentContextUsage(parent, {
      activeInputTokens: 500,
      sessions: [{
        sessionId: "child",
        activeInputTokens: 500,
        capacityLimit: 1_000,
        capacityBasis: "context",
        inputLimit: null,
        contextLimit: 1_000,
        outputLimit: null,
        percentage: 50,
      }],
    })

    expect(attached.activeInputTokens).toBe(250)
    expect(attached.percentage).toBe(25)
    expect(attached.relatedSubagentActiveInputTokens).toBe(500)
    expect(isSameSessionContextUsage(parent, attached)).toBe(false)
    expect(isSameSessionContextUsage(attached, { ...attached })).toBe(true)
  })

  test("keeps current context separate from cumulative processed input", () => {
    const messages = Array.from({ length: 39 }, (_, index) => makeMessage({
      id: `assistant-${index}`,
      role: "assistant",
      tokens: { input: index === 0 ? 99_590 : 99_568 },
    }))
    messages.push(makeMessage({
      id: "assistant-final",
      role: "assistant",
      tokens: {
        input: 2,
        output: 1_464,
        cache: { read: 125_220, write: 1_818 },
      },
    }))

    const usage = getContextUsageFromMessages(messages, capacity(200_000))
    expect(usage?.activeInputTokens).toBe(127_040)
    expect(usage?.lastOutputTokens).toBe(1_464)
    expect(usage?.processedInputTokens).toBe(4_010_214)
  })

  test("never selects token data before the latest compaction boundary", () => {
    const usage = getContextUsageFromMessages([
      { info: makeMessage({ id: "assistant-old", role: "assistant", tokens: { input: 190_000 } }), parts: [] },
      {
        info: makeMessage({ id: "user-compact", role: "user" }),
        parts: [{ id: "part-compact", type: "compaction" } as never],
      },
      { info: makeMessage({ id: "assistant-new", role: "assistant", tokens: { input: 24_000 } }), parts: [] },
    ], capacity(200_000))

    expect(usage?.activeInputTokens).toBe(24_000)
    expect(usage?.lastMessageId).toBe("assistant-new")
  })
})
