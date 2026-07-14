import { describe, expect, test } from "bun:test"
import type { Message } from "@opencode-ai/sdk/v2"
import {
  attachRelatedSubagentContextUsage,
  getContextUsageFromMessages,
  getSubagentContextUsageForSession,
  isSameSessionContextUsage,
} from "./contextUsageUtils"
import { resolveModelContextCapacity } from "./modelContextCapacity"

const makeMessage = (message: Record<string, unknown>): Message => message as unknown as Message
const capacity = (context: number, output?: number) => resolveModelContextCapacity({
  limit: { context, ...(output ? { output } : {}) },
})

describe("getContextUsageFromMessages", () => {
  test("extracts flat assistant token totals", () => {
    const usage = getContextUsageFromMessages([
      makeMessage({ id: "user-1", role: "user" }),
      makeMessage({
        id: "assistant-1",
        role: "assistant",
        tokens: {
          input: 1000,
          output: 200,
          reasoning: 50,
          cache: { read: 10, write: 5 },
        },
      }),
    ], capacity(10_000, 1000))

    expect(usage?.totalTokens).toBe(1265)
    expect(usage?.capacityLimit).toBe(10_000)
    expect(usage?.capacityBasis).toBe("context")
    expect(usage?.contextLimit).toBe(10_000)
    expect(usage?.outputLimit).toBe(1000)
    expect(usage?.percentage).toBe(12.65)
    expect(usage?.hasTokenBreakdown).toBe(true)
    expect(usage?.tokenBreakdown).toEqual({
      input: 1000,
      output: 200,
      reasoning: 50,
      cacheRead: 10,
      cacheWrite: 5,
      total: 1265,
    })
    expect(usage?.sourceAccuracy).toBe("unavailable")
    expect(usage?.sources).toBe(undefined)
  })

  test("uses provider total when it differs from component token fields", () => {
    const usage = getContextUsageFromMessages([
      makeMessage({
        id: "assistant-1",
        role: "assistant",
        tokens: {
          total: 1500,
          input: 1000,
          output: 200,
          reasoning: 50,
          cache: { read: 10, write: 5 },
        },
      }),
    ], capacity(10_000))

    expect(usage?.totalTokens).toBe(1500)
    expect(usage?.tokenBreakdown).toEqual({
      input: 1000,
      output: 200,
      reasoning: 50,
      cacheRead: 10,
      cacheWrite: 5,
      total: 1500,
    })
  })

  test("treats input tokens as provider-reported context rather than literal user prompt tokens", () => {
    const usage = getContextUsageFromMessages([
      makeMessage({ id: "user-1", role: "user", text: "Test prompt" }),
      makeMessage({
        id: "assistant-1",
        role: "assistant",
        tokens: {
          input: 29_000,
          output: 12,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      }),
    ], capacity(200_000))

    expect(usage?.totalTokens).toBe(29_012)
    expect(usage?.tokenBreakdown.input).toBe(29_000)
    expect(usage?.sourceAccuracy).toBe("unavailable")
    expect(usage?.sources).toBe(undefined)
  })

  test("extracts step-finish part token totals when message tokens are unavailable", () => {
    const assistant = makeMessage({ id: "assistant-1", role: "assistant" })
    const usage = getContextUsageFromMessages([
      {
        info: assistant,
        parts: [
          {
            id: "part-1",
            type: "step-finish",
            tokens: {
              total: 900,
              input: 700,
              output: 125,
              reasoning: 75,
              cache: { read: 0, write: 0 },
            },
          } as never,
        ],
      },
    ], capacity(10_000))

    expect(usage?.totalTokens).toBe(900)
    expect(usage?.tokenBreakdown).toEqual({
      input: 700,
      output: 125,
      reasoning: 75,
      cacheRead: 0,
      cacheWrite: 0,
      total: 900,
    })
  })

  test("keeps numeric-only totals usable without pretending source stats exist", () => {
    const usage = getContextUsageFromMessages([
      makeMessage({
        id: "assistant-1",
        role: "assistant",
        tokens: 512,
      }),
    ], capacity(2048))

    expect(usage?.totalTokens).toBe(512)
    expect(usage?.hasTokenBreakdown).toBe(false)
    expect(usage?.tokenBreakdown).toEqual({
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 512,
    })
    expect(usage?.sourceAccuracy).toBe("unavailable")
    expect(usage?.sources).toBe(undefined)
  })

  test("extracts reported source breakdowns", () => {
    const usage = getContextUsageFromMessages([
      makeMessage({
        id: "assistant-1",
        role: "assistant",
        tokens: {
          input: 1000,
          output: 100,
          reasoning: 0,
          cache: { read: 0, write: 0 },
          sources: [
            { source: "system", tokens: 200 },
            { source: "tools", tokens: 100 },
            { source: "conversation", tokens: 700 },
          ],
        },
      }),
    ], capacity(10_000))

    expect(usage?.totalTokens).toBe(1100)
    expect(usage?.sourceAccuracy).toBe("reported")
    expect(usage?.sourceTotalTokens).toBe(1000)
    expect(usage?.sources).toEqual([
      { source: "system", tokens: 200 },
      { source: "tools", tokens: 100 },
      { source: "conversation", tokens: 700 },
    ])
  })

  test("ignores invalid source tokens and normalizes source aliases", () => {
    const usage = getContextUsageFromMessages([
      makeMessage({
        id: "assistant-1",
        role: "assistant",
        tokens: {
          input: 100,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
          sources: [
            { source: "chat", tokens: 40 },
            { source: "tool", tokens: 10 },
            { source: "rules", tokens: -5 },
            { source: "unknown-provider-section", label: "Provider Section", tokens: 15 },
          ],
        },
      }),
    ], capacity(1000))

    expect(usage?.sourceAccuracy).toBe("reported")
    expect(usage?.sourceTotalTokens).toBe(65)
    expect(usage?.sources).toEqual([
      { source: "conversation", tokens: 40 },
      { source: "tools", tokens: 10 },
      { source: "other", label: "Provider Section", tokens: 15 },
    ])
  })

  test("clamps reported source totals to the known token total", () => {
    const usage = getContextUsageFromMessages([
      makeMessage({
        id: "assistant-1",
        role: "assistant",
        tokens: {
          input: 100,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
          sources: [
            { source: "system", tokens: 100 },
            { source: "conversation", tokens: 300 },
          ],
        },
      }),
    ], capacity(1000))

    expect(usage?.sourceTotalTokens).toBe(100)
    expect(usage?.sources).toEqual([
      { source: "system", tokens: 25 },
      { source: "conversation", tokens: 75 },
    ])
  })

  test("returns null when no assistant message has token metadata", () => {
    const usage = getContextUsageFromMessages([
      makeMessage({ id: "user-1", role: "user" }),
      makeMessage({ id: "assistant-1", role: "assistant" }),
    ], capacity(1000))

    expect(usage).toBeNull()
  })

  test("returns the same usage for raw messages and message records", () => {
    const rawMessage = makeMessage({
      id: "assistant-1",
      role: "assistant",
      tokens: {
        input: 75,
        output: 25,
        reasoning: 0,
        cache: { read: 0, write: 0 },
        sources: [{ source: "conversation", tokens: 75 }],
      },
    })

    const rawUsage = getContextUsageFromMessages([rawMessage], capacity(1000))
    const recordUsage = getContextUsageFromMessages([{ info: rawMessage, parts: [] }], capacity(1000))

    expect(isSameSessionContextUsage(rawUsage, recordUsage)).toBe(true)
  })

  test("collects nested child sessions with token data only", () => {
    const messages = new Map<string, Message[]>([
      ["child-1", [makeMessage({ id: "assistant-child-1", role: "assistant", tokens: { input: 200, output: 25 } })]],
      ["child-2", [makeMessage({ id: "assistant-child-2", role: "assistant" })]],
      ["nested-1", [makeMessage({ id: "assistant-nested-1", role: "assistant", tokens: 75 })]],
    ])

    const related = getSubagentContextUsageForSession(
      "parent-1",
      [
        { id: "parent-1" },
        { id: "child-1", parentID: "parent-1", title: "Review agent" },
        { id: "child-2", parentID: "parent-1", title: "No stats yet" },
        { id: "nested-1", parentID: "child-1", title: "Nested agent" },
      ],
      (sessionId) => messages.get(sessionId) ?? [],
      () => capacity(1000),
    )

    expect(related.totalTokens).toBe(300)
    expect(related.sessions).toEqual([
      {
        sessionId: "child-1",
        title: "Review agent",
        totalTokens: 225,
        capacityLimit: 1000,
        capacityBasis: "context",
        inputLimit: null,
        contextLimit: 1000,
        outputLimit: null,
        percentage: 22.5,
        lastMessageId: "assistant-child-1",
      },
      {
        sessionId: "nested-1",
        title: "Nested agent",
        totalTokens: 75,
        capacityLimit: 1000,
        capacityBasis: "context",
        inputLimit: null,
        contextLimit: 1000,
        outputLimit: null,
        percentage: 7.5,
        lastMessageId: "assistant-nested-1",
      },
    ])
  })

  test("attaches related subagent usage without changing parent context totals", () => {
    const usage = getContextUsageFromMessages([
      makeMessage({ id: "assistant-parent", role: "assistant", tokens: { input: 100, output: 25 } }),
    ], capacity(1000))

    expect(usage !== null).toBe(true)
    if (!usage) throw new Error("expected parent context usage")
    const parentPercentage = usage.percentage
    const withRelated = attachRelatedSubagentContextUsage(usage, {
      totalTokens: 300,
      sessions: [{
        sessionId: "child-1",
        totalTokens: 300,
        capacityLimit: 1000,
        capacityBasis: "context",
        inputLimit: null,
        contextLimit: 1000,
        outputLimit: null,
        percentage: 30,
      }],
    })

    expect(withRelated.totalTokens).toBe(125)
    expect(withRelated.percentage).toBe(parentPercentage)
    expect(withRelated.relatedSubagentTotalTokens).toBe(300)
    expect(withRelated.relatedSubagentSessions).toHaveLength(1)
  })

  test("keeps measured usage available when capacity is unknown", () => {
    const usage = getContextUsageFromMessages([
      makeMessage({ id: "assistant-unknown", role: "assistant", tokens: 512 }),
    ], resolveModelContextCapacity(undefined))

    expect(usage?.totalTokens).toBe(512)
    expect(usage?.percentage).toBeNull()
    expect(usage?.capacityLimit).toBeNull()
    expect(usage?.capacityBasis).toBe("unavailable")
    expect(usage?.inputLimit).toBeNull()
    expect(usage?.contextLimit).toBeNull()
    expect(usage?.outputLimit).toBeNull()
  })

  test("does not clamp percentages above one hundred percent", () => {
    const usage = getContextUsageFromMessages([
      makeMessage({ id: "assistant-over", role: "assistant", tokens: 1250 }),
    ], capacity(1000))

    expect(usage?.percentage).toBe(125)
  })

  test("treats capacity metadata changes as distinct usage projections", () => {
    const messages = [makeMessage({ id: "assistant-capacity", role: "assistant", tokens: 500 })]
    const known = getContextUsageFromMessages(messages, capacity(1000))
    const unavailable = getContextUsageFromMessages(messages, resolveModelContextCapacity(undefined))

    expect(isSameSessionContextUsage(known, unavailable)).toBe(false)
  })
})
