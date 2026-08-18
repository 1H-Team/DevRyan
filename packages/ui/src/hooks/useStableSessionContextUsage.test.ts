import { describe, expect, test } from "bun:test"
import type { SessionContextUsage } from "@/stores/types/sessionTypes"
import { reduceStableSessionContextUsage } from "./useStableSessionContextUsage"

const usage = (activeInputTokens: number): SessionContextUsage => ({
  activeInputTokens,
  lastOutputTokens: 0,
  source: "message-fallback",
  updatedAt: 1,
  percentage: 10,
  capacityLimit: 1000,
  capacityBasis: "input",
  inputLimit: 1000,
  contextLimit: 1200,
  outputLimit: 200,
  tokenBreakdown: {
    input: activeInputTokens,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: activeInputTokens,
  },
  hasTokenBreakdown: true,
})

describe("reduceStableSessionContextUsage", () => {
  test("retains completed usage while the same session is unresolved", () => {
    const previous = reduceStableSessionContextUsage(undefined, {
      directory: "/repo",
      sessionId: "session-a",
      usage: usage(100),
      resolved: true,
    })

    expect(reduceStableSessionContextUsage(previous, {
      directory: "/repo",
      sessionId: "session-a",
      usage: null,
      resolved: false,
    })).toBe(previous)
  })

  test("clears immediately when navigating to another unresolved session", () => {
    const previous = reduceStableSessionContextUsage(undefined, {
      directory: "/repo-a",
      sessionId: "session-a",
      usage: usage(100),
      resolved: true,
    })

    expect(reduceStableSessionContextUsage(previous, {
      directory: "/repo-b",
      sessionId: "session-b",
      usage: null,
      resolved: false,
    })).toEqual({ key: '["/repo-b","session-b"]', usage: null })
  })

  test("clears an authoritative empty result for the same session", () => {
    const previous = reduceStableSessionContextUsage(undefined, {
      directory: "/repo",
      sessionId: "session-a",
      usage: usage(100),
      resolved: true,
    })

    expect(reduceStableSessionContextUsage(previous, {
      directory: "/repo",
      sessionId: "session-a",
      usage: null,
      resolved: true,
    }).usage).toBeNull()
  })
})
