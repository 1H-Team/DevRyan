import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { renderToStaticMarkup } from "react-dom/server"

import { QuestionExplanation } from "./QuestionPromptText"
import { splitQuestionPrompt } from "./questionPrompt"

const deviationQuestion = [
  "Should the audit flag live on the user row instead of a new table?",
  "What changes: the flag is stored on the existing user record.",
  "Why: the planned table duplicates data the user row already owns.",
  "For end users: nothing visible changes.",
  "Security & data: no new permissions; existing row-level rules apply.",
  "Reversibility: one migration moves it back.",
  "If we keep the original plan: an extra table and a slower query.",
].join("\n")

describe("splitQuestionPrompt", () => {
  test("keeps a single-line question as the label with no explanation", () => {
    expect(splitQuestionPrompt("Which theme should we use?")).toEqual({
      title: "Which theme should we use?",
      explanation: [],
    })
  })

  test("splits at the first newline and drops blank lines", () => {
    const parts = splitQuestionPrompt("Line one\n\n  Why: because  \r\nPlain detail\n")
    expect(parts.title).toBe("Line one")
    expect(parts.explanation).toEqual(["Why: because", "Plain detail"])
  })

  test("uses the first non-empty line as the label", () => {
    expect(splitQuestionPrompt("\n\nActual question\nDetail").title).toBe("Actual question")
    expect(splitQuestionPrompt("   ")).toEqual({ title: "", explanation: [] })
  })
})

describe("QuestionExplanation", () => {
  test("renders nothing without explanation lines", () => {
    expect(renderToStaticMarkup(<QuestionExplanation lines={[]} />)).toBe("")
  })

  test("renders labelled lines with an emphasized label and plain lines as-is", () => {
    const { explanation } = splitQuestionPrompt(deviationQuestion)
    const html = renderToStaticMarkup(
      <QuestionExplanation lines={[...explanation, "Plain closing note."]} className="mb-2" />,
    )

    expect(html).toContain("typography-micro text-muted-foreground whitespace-pre-wrap mb-2")
    expect(html.match(/font-medium text-foreground/g)).toHaveLength(6)
    expect(html).toContain('<span class="font-medium text-foreground">Security &amp; data:</span>')
    expect(html).toContain("existing row-level rules apply.")
    expect(html).toContain("If we keep the original plan:</span>")
    expect(html).toContain("Plain closing note.")
  })

  test("does not treat lowercase or overlong prefixes as labels", () => {
    const html = renderToStaticMarkup(
      <QuestionExplanation lines={["note: lowercase prefix", `${"A".repeat(45)}: too long`]} />,
    )
    expect(html).not.toContain("font-medium text-foreground")
    expect(html).toContain("note: lowercase prefix")
  })
})

describe("QuestionCard question body", () => {
  const source = readFileSync(fileURLToPath(new URL("./QuestionCard.tsx", import.meta.url)), "utf8")

  test("splits the question and keeps line 1 as the label and aria-label", () => {
    expect(source).toContain("splitQuestionPrompt(entry.question.question)")
    expect(source).toContain("{prompt.title}</div>")
    expect(source).toContain("aria-label={prompt.title}")
    expect(source).toContain("<QuestionExplanation lines={prompt.explanation}")
    expect(source).not.toContain("aria-label={entry.question.question}")
  })
})
