import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, mock, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"

mock.module("../../MarkdownRenderer", () => ({
  MarkdownRenderer: ({
    content,
    isStreaming,
    variant,
  }: {
    content: string
    isStreaming: boolean
    variant: string
  }) => (
    <div
      data-testid="markdown-renderer"
      data-streaming={String(isStreaming)}
      data-variant={variant}
    >
      {content}
    </div>
  ),
}))

mock.module("@/stores/useUIStore", () => ({
  useUIStore: (selector: (state: { chatRenderMode: "live" }) => unknown) => selector({ chatRenderMode: "live" }),
}))

mock.module("@/lib/i18n", () => ({
  useI18n: () => ({
    t: (key: string) => ({
      "chat.reasoning.thinking": "Thinking…",
    })[key] ?? key,
  }),
}))

const {
  default: ReasoningPart,
  formatReasoningText,
} = await import("./ReasoningPart")

const createReasoningPart = ({
  id,
  text,
  active = false,
  metadata,
}: {
  id: string
  text: string
  active?: boolean
  metadata?: Record<string, unknown>
}): Part => ({
  id,
  messageID: "message-1",
  sessionID: "session-1",
  type: "reasoning",
  text,
  time: active ? { start: 1_000 } : { start: 1_000, end: 3_000 },
  metadata,
} as Part)

const renderReasoning = (part: Part): string => renderToStaticMarkup(
  <ReasoningPart part={part} messageId="message-1" />,
)

const expectNoDisclosurePresentation = (html: string): void => {
  expect(html).not.toContain("<button")
  expect(html).not.toContain("<svg")
  expect(html).not.toContain("aria-expanded")
  expect(html).not.toContain("Thought")
  expect(html).not.toContain("Reasoning summary")
  expect(html).not.toContain("2.0s")
}

describe("ReasoningPart", () => {
  test("renders completed Anthropic reasoning Markdown immediately", () => {
    const reasoning = "I will use the source code and browser measurements."
    const html = renderReasoning(createReasoningPart({
      id: "anthropic-reasoning",
      text: reasoning,
      metadata: { providerID: "anthropic" },
    }))

    expect(html).toContain(`<div data-testid="markdown-renderer" data-streaming="false" data-variant="reasoning">${reasoning}</div>`)
    expectNoDisclosurePresentation(html)
  })

  test("renders completed Cursor reasoning Markdown immediately", () => {
    const reasoning = "First Cursor thought.\n\nSecond Cursor thought."
    const html = renderReasoning(createReasoningPart({
      id: "cursor-reasoning",
      text: reasoning,
      metadata: { cursorSdk: true, providerID: "cursor-acp" },
    }))

    expect(html).toContain(reasoning)
    expectNoDisclosurePresentation(html)
  })

  test("renders completed hosted OpenAI reasoning Markdown immediately", () => {
    const reasoning = "**Checking the constraints**\n\nThe available evidence supports the answer."
    const html = renderReasoning(createReasoningPart({
      id: "openai-reasoning",
      text: reasoning,
      metadata: { providerID: "openai" },
    }))

    expect(html).toContain(reasoning)
    expectNoDisclosurePresentation(html)
  })

  test("renders multi-paragraph Markdown exactly once", () => {
    const title = "Reviewing calendar layout"
    const reasoning = `**${title}**\n\nDetails from the browser measurements.\n\nSecond observation.`
    const html = renderReasoning(createReasoningPart({ id: "reasoning-multi-paragraph", text: reasoning }))

    expect(html).toContain(`<div data-testid="markdown-renderer" data-streaming="false" data-variant="reasoning">${reasoning}</div>`)
    expect(html.match(new RegExp(title, "g"))).toHaveLength(1)
  })

  test("renders title-only Markdown exactly once", () => {
    const title = "Planning systematic debugging approach"
    const reasoning = `**${title}**`
    const html = renderReasoning(createReasoningPart({ id: "reasoning-title-only", text: reasoning }))

    expect(html.match(new RegExp(title, "g"))).toHaveLength(1)
    expect(html).toContain(`<div data-testid="markdown-renderer" data-streaming="false" data-variant="reasoning">${reasoning}</div>`)
  })

  test("keeps non-empty reasoning visible while active and after completion", () => {
    const activeHtml = renderReasoning(createReasoningPart({
      id: "reasoning-lifecycle",
      text: "First observation.",
      active: true,
    }))
    const completedHtml = renderReasoning(createReasoningPart({
      id: "reasoning-lifecycle",
      text: "First observation.\n\nSecond observation.",
    }))

    expect(activeHtml).toContain('data-streaming="true"')
    expect(activeHtml).toContain("First observation.")
    expect(completedHtml).toContain('data-streaming="false"')
    expect(completedHtml).toContain("First observation.\n\nSecond observation.")
    expectNoDisclosurePresentation(activeHtml)
    expectNoDisclosurePresentation(completedHtml)
  })

  test("renders an accessible status while active reasoning is still empty", () => {
    const html = renderReasoning(createReasoningPart({
      id: "reasoning-empty-active",
      text: "",
      active: true,
    }))

    expect(html).toContain('data-reasoning-block-id="reasoning-empty-active"')
    expect(html).toContain('role="status"')
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain("animate-pulse motion-reduce:animate-none")
    expect(html).toContain("Thinking…")
    expect(html).not.toContain("<button")
  })

  test("renders nothing when completed reasoning has empty text", () => {
    expect(renderReasoning(createReasoningPart({
      id: "reasoning-empty-completed",
      text: "",
    }))).toBe("")
  })

  test("formats reasoning while preserving repeated skill/action status lines", () => {
    const noisy = "Exploring skills index I need to inspect the skills index."
    const useful = "The skills index determines which skill file should be loaded."

    expect(formatReasoningText(`${noisy}\n\n${useful}`)).toBe(`${noisy}\n\n${useful}`)
  })

  test("preserves provider-authored Markdown paragraphs and blockquotes", () => {
    const reasoning = "First paragraph.\n\n> Browser measurement quoted by the model.\n> Second quoted line.\n\nFinal paragraph."

    expect(formatReasoningText(`\n${reasoning}\n`)).toBe(reasoning)
  })

  test("formats reasoning while preserving skill-conflict status lines", () => {
    const noisy = "Addressing skill conflicts I think I need to act here and consider how to apply systematic debugging to address the bug."
    const useful = "The orchestrator prompt conflicts with skills that require announcements."

    expect(formatReasoningText(`${noisy}\n\n${useful}`)).toBe(`${noisy}\n\n${useful}`)
  })

  test("formats reasoning while preserving skill-announcement conflict sections", () => {
    const noisy = "**Clarifying plan execution**\n\nThe user provided a brief plan. My skill indicates that I should save the plan and announce it, but the platform announcement policy is tool-only."
    const useful = "The final response should contain the concise plan only."

    expect(formatReasoningText(`${noisy}\n\n${useful}`)).toBe(`${noisy}\n\n${useful}`)
  })
})
