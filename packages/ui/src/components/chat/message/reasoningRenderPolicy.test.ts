import { describe, expect, test } from "bun:test"
import {
  filterGroupedActivityReasoning,
  getReasoningPartRenderKey,
  shouldRenderReasoning,
} from "./reasoningRenderPolicy"

describe("reasoning render policy", () => {
  test("keeps reasoning out of collapsible grouped activity", () => {
    const parts = [
      { id: "reasoning_1", kind: "reasoning" },
      { id: "tool_1", kind: "tool" },
      { id: "justification_1", kind: "justification" },
    ]

    expect(filterGroupedActivityReasoning(parts)).toEqual([
      { id: "tool_1", kind: "tool" },
      { id: "justification_1", kind: "justification" },
    ])
  })

  test("preserves the original grouped activity reference when no reasoning exists", () => {
    const parts = [{ id: "tool_1", kind: "tool" }]

    expect(filterGroupedActivityReasoning(parts)).toBe(parts)
  })

  test("uses the global reasoning setting as the visibility gate", () => {
    expect(shouldRenderReasoning(true)).toBe(true)
    expect(shouldRenderReasoning(false)).toBe(false)
  })

  test("keeps a reasoning block's React identity stable when streaming inserts move its index", () => {
    expect(getReasoningPartRenderKey("message-1", "reasoning-1", 2)).toBe("reasoning-message-1-reasoning-1")
    expect(getReasoningPartRenderKey("message-1", "reasoning-1", 7)).toBe("reasoning-message-1-reasoning-1")
    expect(getReasoningPartRenderKey("message-1", undefined, 2)).toBe("reasoning-message-1-2")
  })
})
