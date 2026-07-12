import { describe, expect, test } from "bun:test"
import {
  filterGroupedActivityReasoning,
  shouldRenderInlineReasoning,
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

  test("uses the global reasoning setting as the inline visibility gate", () => {
    expect(shouldRenderInlineReasoning(true)).toBe(true)
    expect(shouldRenderInlineReasoning(false)).toBe(false)
  })
})
