import { describe, expect, test } from "bun:test"
import type { MouseEvent } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { QuestionOptionRow } from "./QuestionOptionRow"

describe("QuestionOptionRow", () => {
  test("uses one native button as the only interactive option owner", () => {
    const html = renderToStaticMarkup(
      <QuestionOptionRow
        label="Keep changes"
        description="Preserve the current implementation."
        selected={false}
        multiple
        disabled={false}
        recommended={false}
        recommendedLabel="Recommended"
        onSelect={() => undefined}
      />,
    )

    expect(html.match(/<button/g)).toHaveLength(1)
    expect(html).toContain('type="button"')
    expect(html).toContain('role="checkbox"')
    expect(html).toContain('aria-checked="false"')
    expect(html).not.toContain("<input")
  })

  test("one pointer activation invokes selection exactly once", () => {
    let selections = 0
    const element = QuestionOptionRow({
      label: "Use recommended",
      description: "",
      selected: true,
      multiple: false,
      disabled: false,
      recommended: true,
      recommendedLabel: "Recommended",
      onSelect: () => {
        selections += 1
      },
    })

    const onClick = element.props.onClick
    if (!onClick) throw new Error("expected option row click handler")
    onClick({} as MouseEvent<HTMLButtonElement>)

    expect(selections).toBe(1)
  })

  test("single-choice rows expose radio semantics and decorative visuals", () => {
    const html = renderToStaticMarkup(
      <QuestionOptionRow
        label="One"
        description=""
        selected
        multiple={false}
        disabled={false}
        recommended={false}
        recommendedLabel="Recommended"
        onSelect={() => undefined}
      />,
    )

    expect(html).toContain('role="radio"')
    expect(html).toContain('aria-checked="true"')
    expect(html).toContain('aria-hidden="true"')
  })
})
