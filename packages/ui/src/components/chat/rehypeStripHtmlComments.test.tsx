import React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "bun:test"
import ReactMarkdown from "react-markdown"

import { rehypeStripHtmlComments } from "./rehypeStripHtmlComments"

const renderMarkdown = (markdown: string): string =>
  renderToStaticMarkup(
    <ReactMarkdown rehypePlugins={[rehypeStripHtmlComments]}>{markdown}</ReactMarkdown>,
  )

describe("rehypeStripHtmlComments", () => {
  test("drops a standalone comment between blocks (thinking-block artifact)", () => {
    const html = renderMarkdown("Thinking done.\n\n<!-- -->\n\nThe answer is 42.")

    expect(html).toContain("Thinking done.")
    expect(html).toContain("The answer is 42.")
    expect(html).not.toContain("&lt;!--")
    expect(html).not.toContain("--&gt;")
  })

  test("drops the plan card sentinel comment", () => {
    const html = renderMarkdown("Preamble text\n\n<!--plan-->\n\n# Plan")

    expect(html).toContain("Preamble text")
    expect(html).toContain("Plan")
    expect(html).not.toContain("&lt;!--plan--&gt;")
    expect(html).not.toContain("&lt;!--")
  })

  test("drops an inline comment while keeping surrounding text", () => {
    const html = renderMarkdown("before <!-- hidden note --> after")

    expect(html).toContain("before")
    expect(html).toContain("after")
    expect(html).not.toContain("hidden note")
    expect(html).not.toContain("&lt;!--")
  })

  test("drops an unterminated trailing comment (mid-stream partial)", () => {
    const html = renderMarkdown("streamed text\n\n<!-- partial comment that never clo")

    expect(html).toContain("streamed text")
    expect(html).not.toContain("partial comment")
    expect(html).not.toContain("&lt;!--")
  })

  test("preserves comments inside code fences", () => {
    const html = renderMarkdown("```html\n<!-- keep me -->\n```")

    expect(html).toContain("&lt;!-- keep me --&gt;")
  })

  test("preserves comments inside inline code", () => {
    const html = renderMarkdown("Use `<!-- comment -->` in HTML")

    expect(html).toContain("&lt;!-- comment --&gt;")
  })

  test("keeps non-comment raw HTML rendering as literal text (unchanged behavior)", () => {
    const html = renderMarkdown("mention of <custom-tag> in prose")

    expect(html).toContain("&lt;custom-tag&gt;")
  })

  test("strips comments embedded in a raw node while keeping the rest", () => {
    const html = renderMarkdown("<div><!-- note --></div>\n\nafter")

    expect(html).toContain("&lt;div&gt;")
    expect(html).not.toContain("note")
    expect(html).toContain("after")
  })
})
