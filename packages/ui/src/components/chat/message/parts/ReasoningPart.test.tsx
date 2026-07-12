import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, mock, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"

mock.module("../../MarkdownRenderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="markdown-renderer">{content}</div>
  ),
}))

mock.module("@/stores/useUIStore", () => ({
  useUIStore: (selector: (state: { chatRenderMode: "live" }) => unknown) => selector({ chatRenderMode: "live" }),
}))

const { default: ReasoningPart, ReasoningTimelineBlock, formatReasoningText } = await import("./ReasoningPart")

describe("ReasoningTimelineBlock", () => {
  test("renders reasoning text inline without a thinking header or timer", () => {
    const html = renderToStaticMarkup(
      <ReasoningTimelineBlock
        text={"First thought\n\nSecond thought"}
        variant="thinking"
        blockId="reasoning-inline"
        time={{ start: 1_000, end: 3_000 }}
        showDuration={true}
      />,
    )

    expect(html).toContain("First thought")
    expect(html).toContain("Second thought")
    expect(html).not.toContain("Thinking")
    expect(html).not.toContain("2.0s")
    expect(html).not.toContain("aria-expanded")
  })

  test("renders Cursor reasoning inline like every other provider", () => {
    const part = {
      id: "cursor-reasoning",
      messageID: "message-1",
      sessionID: "session-1",
      type: "reasoning",
      text: "First long Cursor thought\n\nSecond long Cursor thought",
      time: { start: 1_000, end: 3_000 },
      metadata: { cursorSdk: true, providerID: "cursor-acp" },
    } as Part
    const html = renderToStaticMarkup(
      <ReasoningPart part={part} messageId="message-1" />,
    )

    expect(html).not.toContain("<details")
    expect(html).not.toContain("Thinking")
    expect(html).toContain("First long Cursor thought")
    expect(html).toContain("Second long Cursor thought")
  })

  test("formats reasoning while preserving repeated skill/action status lines", () => {
    const noisy = "Exploring skills index I need to inspect the skills index."
    const useful = "The skills index determines which skill file should be loaded."

    expect(formatReasoningText(`${noisy}\n\n${useful}`)).toBe(`${noisy}\n${useful}`)
  })

  test("formats reasoning while preserving skill-conflict status lines", () => {
    const noisy = "Addressing skill conflicts I think I need to act here and consider how to apply systematic debugging to address the bug."
    const useful = "The orchestrator prompt conflicts with skills that require announcements."

    expect(formatReasoningText(`${noisy}\n\n${useful}`)).toBe(`${noisy}\n${useful}`)
  })

  test("formats reasoning while preserving skill-announcement conflict sections", () => {
    const noisy = "**Clarifying plan execution**\n\nThe user provided a brief plan. My skill indicates that I should save the plan and announce it, but the platform announcement policy is tool-only."
    const useful = "The final response should contain the concise plan only."

    expect(formatReasoningText(`${noisy}\n\n${useful}`)).toBe(`${noisy.replace("\n\n", "\n")}\n${useful}`)
  })
})
