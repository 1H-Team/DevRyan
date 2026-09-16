import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import {
  filterGroupedActivityReasoning,
  getReasoningPartRenderKey,
  isKnownClippedXaiReasoningPreview,
  stripKnownClippedXaiReasoningPrefix,
  shouldRenderReasoning,
} from "./reasoningRenderPolicy"

const clippedXaiPreview = `${"x".repeat(200)}...`

const reasoningPart = (text: string, ended = true): Part => ({
  id: "reasoning-1",
  messageID: "message-1",
  sessionID: "session-1",
  type: "reasoning",
  text,
  time: ended ? { start: 1_000, end: 2_000 } : { start: 1_000 },
} as Part)

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

  test("recognizes only the finalized xAI clipped-summary fingerprint", () => {
    expect(isKnownClippedXaiReasoningPreview(reasoningPart(clippedXaiPreview), " XAI ")).toBe(true)

    expect(isKnownClippedXaiReasoningPreview(reasoningPart(clippedXaiPreview, false), "xai")).toBe(false)
    expect(isKnownClippedXaiReasoningPreview(reasoningPart(clippedXaiPreview), "openai")).toBe(false)
    expect(isKnownClippedXaiReasoningPreview(reasoningPart(clippedXaiPreview), undefined)).toBe(false)
    expect(isKnownClippedXaiReasoningPreview(reasoningPart(`${"x".repeat(199)}...`), "xai")).toBe(false)
    expect(isKnownClippedXaiReasoningPreview(reasoningPart(`${"x".repeat(201)}...`), "xai")).toBe(false)
    expect(isKnownClippedXaiReasoningPreview(reasoningPart(`${"x".repeat(202)}…`), "xai")).toBe(false)
    expect(isKnownClippedXaiReasoningPreview(reasoningPart("Complete xAI reasoning."), "xai")).toBe(false)
  })

  test("keeps a reasoning block's React identity stable when streaming inserts move its index", () => {
    expect(getReasoningPartRenderKey("message-1", "reasoning-1", 2)).toBe("reasoning-message-1-reasoning-1")
    expect(getReasoningPartRenderKey("message-1", "reasoning-1", 7)).toBe("reasoning-message-1-reasoning-1")
    expect(getReasoningPartRenderKey("message-1", undefined, 2)).toBe("reasoning-message-1-2")
  })

  test("removes only the confirmed clipped prefix when a fuller summary follows", () => {
    const summary = "The full summary.\n\n```tsx\nconst open = true;\n```"
    expect(stripKnownClippedXaiReasoningPrefix(`${clippedXaiPreview}${summary}`, " XAI ")).toBe(summary)
    expect(stripKnownClippedXaiReasoningPrefix(`${clippedXaiPreview}\n\n${summary}`, "xai")).toBe(summary)
    expect(stripKnownClippedXaiReasoningPrefix(clippedXaiPreview, "xai")).toBe(clippedXaiPreview)
    expect(isKnownClippedXaiReasoningPreview(reasoningPart(`${clippedXaiPreview}${summary}`), "xai")).toBe(false)
    for (const text of [`${"x".repeat(199)}...${summary}`, `${"x".repeat(201)}...${summary}`, `${"x".repeat(200)}....${summary}`, "Consider this... and preserve the rest."]) {
      expect(stripKnownClippedXaiReasoningPrefix(text, "xai")).toBe(text)
    }
    for (const provider of ["openai", "anthropic", undefined]) {
      expect(stripKnownClippedXaiReasoningPrefix(`${clippedXaiPreview}${summary}`, provider)).toBe(`${clippedXaiPreview}${summary}`)
    }
  })

  test("counts Unicode characters when recognizing the provider's 200-character preview", () => {
    const preview = `${"🧭".repeat(100)}${"x".repeat(100)}...`
    expect(isKnownClippedXaiReasoningPreview(reasoningPart(preview), "xai")).toBe(true)
    expect(stripKnownClippedXaiReasoningPrefix(`${preview}Complete summary.`, "xai")).toBe("Complete summary.")
  })
})
