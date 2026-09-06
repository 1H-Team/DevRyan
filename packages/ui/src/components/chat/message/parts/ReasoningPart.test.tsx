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
} = await import("./ReasoningPart")
const {
  default: JustificationBlock,
} = await import("./JustificationBlock")
const { formatReasoningText } = await import("./reasoningSummaryDisplay")

const clippedXaiPreview = `${"x".repeat(200)}...`

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

const renderReasoning = (
  part: Part,
  options: {
    providerID?: string;
    responseStyleLevel?: "provider" | "actions" | "concise" | "detailed";
    isMessageCompleted?: boolean;
    isMobile?: boolean;
  } = {},
): string => renderToStaticMarkup(
  <ReasoningPart part={part} messageId="message-1" {...options} />,
)

const createJustificationPart = (text: string): Part => ({
  id: "justification-1",
  messageID: "message-1",
  sessionID: "session-1",
  type: "text",
  text,
} as Part)

const renderJustification = (
  text: string,
  options: {
    isMessageCompleted?: boolean;
    isMobile?: boolean;
  } = {},
): string => renderToStaticMarkup(
  <JustificationBlock
    part={createJustificationPart(text)}
    messageId="message-1"
    {...options}
  />,
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
  test("authoritative message completion stops reasoning whose part has no end timestamp", () => {
    const html = renderReasoning(createReasoningPart({
      id: "cancelled-reasoning",
      text: "Partial reasoning retained after cancellation.",
      active: true,
    }), { isMessageCompleted: true })

    expect(html).toContain('data-streaming="false"')
    expect(html).toContain("Partial reasoning retained after cancellation.")
  })

  test("renders completed Anthropic reasoning Markdown immediately", () => {
    const reasoning = "I will use the source code and browser measurements."
    const html = renderReasoning(createReasoningPart({
      id: "anthropic-reasoning",
      text: reasoning,
      metadata: { providerID: "anthropic" },
    }))

    expect(html).toContain(`<div data-testid="markdown-renderer" data-streaming="false" data-variant="reasoning">${reasoning}</div>`)
    expect(html).toContain('data-reasoning-block-id="anthropic-reasoning"')
    expect(html).not.toContain('data-assistant-update-block-id')
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
    }), { providerID: "openai", responseStyleLevel: "detailed" })

    expect(html).toContain("**Checking the constraints.**\n\nThe available evidence supports the answer.")
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
    expect(activeHtml).not.toContain('data-reasoning-shimmer')
    expect(activeHtml).toContain("First observation.")
    expect(completedHtml).toContain('data-streaming="false"')
    expect(completedHtml).not.toContain('data-reasoning-shimmer')
    expect(completedHtml).toContain("First observation.\n\nSecond observation.")
    expectNoDisclosurePresentation(activeHtml)
    expectNoDisclosurePresentation(completedHtml)
  })

  test("keeps active and completed reasoning on the same outer spacing contract", () => {
    const activeHtml = renderReasoning(createReasoningPart({
      id: "reasoning-spacing-active",
      text: "Checking the current output rhythm.",
      active: true,
    }))
    const completedHtml = renderReasoning(createReasoningPart({
      id: "reasoning-spacing-completed",
      text: "Checking the current output rhythm.",
    }))

    expect(activeHtml).toContain('class="relative pr-2 py-1.5"')
    expect(completedHtml).toContain('class="relative pr-2 py-1.5"')
    expect(activeHtml).not.toContain('class="my-1')
    expect(completedHtml).not.toContain('class="my-1')
  })

  test("uses compact spacing for both active and completed mobile reasoning", () => {
    const activeHtml = renderReasoning(createReasoningPart({
      id: "reasoning-mobile-active",
      text: "Checking the current output rhythm.",
      active: true,
    }), { isMobile: true })
    const completedHtml = renderReasoning(createReasoningPart({
      id: "reasoning-mobile-completed",
      text: "Checking the current output rhythm.",
    }), { isMobile: true })

    expect(activeHtml).toContain('class="relative pr-2 py-1"')
    expect(completedHtml).toContain('class="relative pr-2 py-1"')
    expect(activeHtml).not.toContain('py-1.5')
    expect(completedHtml).not.toContain('py-1.5')
  })

  test("renders nothing while active reasoning is still empty (the disclosure owns Thinking)", () => {
    expect(renderReasoning(createReasoningPart({
      id: "reasoning-empty-active",
      text: "",
      active: true,
    }))).toBe("")
  })

  test("renders nothing when completed reasoning has empty text", () => {
    expect(renderReasoning(createReasoningPart({
      id: "reasoning-empty-completed",
      text: "",
    }))).toBe("")
  })

  test("hides only finalized clipped xAI previews without mutating canonical text", () => {
    const clippedPart = createReasoningPart({
      id: "reasoning-clipped-xai",
      text: clippedXaiPreview,
    })
    const canonicalSnapshot = JSON.stringify(clippedPart)

    expect(renderReasoning(clippedPart, { providerID: "xai" })).toBe("")
    expect(JSON.stringify(clippedPart)).toBe(canonicalSnapshot)

    expect(renderReasoning(createReasoningPart({
      id: "reasoning-active-xai",
      text: clippedXaiPreview,
      active: true,
    }), { providerID: "xai" })).toContain(clippedXaiPreview)

    expect(renderReasoning(createReasoningPart({
      id: "reasoning-other-provider",
      text: clippedXaiPreview,
    }), { providerID: "anthropic" })).toContain(clippedXaiPreview)

    const longerPreview = `${"x".repeat(201)}...`
    expect(renderReasoning(createReasoningPart({
      id: "reasoning-longer-xai",
      text: longerPreview,
    }), { providerID: "xai" })).toContain(longerPreview)
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

  test("projects OpenAI summaries to visibly distinct rationale depths", () => {
    const summary = "**Evaluating frontend design necessity**\n\nThe fixture contains no user interface, so frontend design expertise would not affect the finding\n\nThe test result supplies the remaining evidence"

    expect(formatReasoningText(summary, "openai", "actions")).toBe("**Evaluating frontend design necessity.**")
    expect(formatReasoningText(summary, "openai", "concise")).toBe(
      "**Evaluating frontend design necessity.**\n\nThe fixture contains no user interface, so frontend design expertise would not affect the finding.",
    )
    expect(formatReasoningText(summary, "openai", "detailed")).toBe(
      "**Evaluating frontend design necessity.**\n\nThe fixture contains no user interface, so frontend design expertise would not affect the finding.\n\nThe test result supplies the remaining evidence.",
    )
    expect(formatReasoningText(summary, "openai", "provider")).toBe(
      "**Evaluating frontend design necessity.**\n\nThe fixture contains no user interface, so frontend design expertise would not affect the finding.\n\nThe test result supplies the remaining evidence.",
    )
  })

  test("preserves OpenAI headings, lists, code, links, multiline blocks, and existing punctuation", () => {
    const markdown = [
      "# Evaluation heading",
      "- Read README.md",
      "`node --test src/math.test.ts`",
      "[Open the report](https://example.com/report)",
      "First line\nSecond line",
      "Already complete!",
    ].join("\n\n")

    expect(formatReasoningText(markdown, "openai", "detailed")).toBe(markdown)
  })

  test("leaves non-OpenAI reasoning unchanged at every display depth", () => {
    const summary = "**Unpunctuated title**\n\nUnpunctuated explanation"

    expect(formatReasoningText(summary, "anthropic", "actions")).toBe(summary)
    expect(formatReasoningText(summary, "cursor-acp", "detailed")).toBe(summary)
  })

  test("keeps the projected OpenAI headline stable as streaming adds rationale", () => {
    const partial = formatReasoningText("**Evaluating frontend design necessity**", "openai", "concise")
    const completed = formatReasoningText(
      "**Evaluating frontend design necessity**\n\nThe repository contents determine whether design expertise is relevant",
      "openai",
      "concise",
    )

    expect(partial).toBe("**Evaluating frontend design necessity.**")
    expect(completed.match(/Evaluating frontend design necessity/g)).toHaveLength(1)
    expect(completed.startsWith(partial)).toBe(true)
  })
})

describe("JustificationBlock", () => {
  test("separates an attached leading bold title from its body at render time", () => {
    const html = renderJustification("**Planning the focused change**The helper already has nearby tests.")

    expect(html).toContain("**Planning the focused change**\n\nThe helper already has nearby tests.")
  })

  test("preserves ordinary provider-authored Markdown and block spacing", () => {
    const markdown = [
      "First paragraph.",
      "> Provider-authored quote.\n> Second quoted line.",
      "- Read `src/math.ts`",
      "[Open the test](https://example.com/test)",
      "```ts\nmultiply(2, 3)\n```",
    ].join("\n\n")

    const html = renderJustification(markdown)

    expect(html.replaceAll("&gt;", ">")).toContain(
      `<div data-testid="markdown-renderer" data-streaming="false" data-variant="assistant">${markdown}</div>`,
    )
  })

  test("uses assistant presentation and update semantics for public narration", () => {
    const html = renderJustification("I’m checking the existing helper first.")

    expect(html).toContain('data-assistant-update-block-id="justification-1"')
    expect(html).toContain('data-variant="assistant"')
    expect(html).not.toContain('data-reasoning-block-id')
    expect(html).not.toContain('data-variant="reasoning"')
  })

  test("does not split ordinary leading bold prose that already has whitespace", () => {
    const markdown = "**Important** context remains on the same line."

    expect(renderJustification(markdown)).toContain(markdown)
  })

  test("does not split ordinary leading bold labels followed by punctuation", () => {
    const markdown = "**Important**: context remains on the same line."

    expect(renderJustification(markdown)).toContain(markdown)
  })

  test("marks live incomplete narration as streaming and completed narration as static", () => {
    expect(renderJustification("Inspecting the current implementation.", {
      isMessageCompleted: false,
    })).toContain('data-streaming="true"')
    expect(renderJustification("Inspecting the current implementation.", {
      isMessageCompleted: true,
    })).toContain('data-streaming="false"')
  })

  test("uses compact mobile spacing", () => {
    expect(renderJustification("Inspecting the current implementation.", {
      isMobile: true,
    })).toContain('class="relative pr-2 py-1"')
  })
})
