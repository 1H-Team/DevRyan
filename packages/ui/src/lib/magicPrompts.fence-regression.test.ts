import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { MAGIC_PROMPT_DEFINITIONS } from "./magicPrompts"

// Regression guard: when the legacy plan-card markdown parser was removed,
// the corresponding "wrap the plan in ```plan.md fences" instruction had to
// go too — otherwise the assistant produces fenced code blocks that the
// MarkdownRenderer shows as <pre><code> instead of typeset prose.
//
// If this test fails, someone reintroduced the fence instruction. Do NOT
// reintroduce the markdown parser to compensate. Update the prompt to keep
// asking for ordinary markdown.

const FORBIDDEN_FENCE_PATTERNS: ReadonlyArray<RegExp> = [
  /wrap (?:only )?the plan body in a fenced/i,
  /fenced markdown block whose opening fence is exactly/i,
  /\bopening fence is .*plan\.md/i,
]

describe("plan-mode prompts no longer require ```plan.md fences", () => {
  test("plan.todo.instructions does not instruct fenced plan output", () => {
    const def = MAGIC_PROMPT_DEFINITIONS.find((d) => d.id === "plan.todo.instructions")
    if (!def) throw new Error("plan.todo.instructions definition missing")
    const template = def.template
    for (const pattern of FORBIDDEN_FENCE_PATTERNS) {
      expect(pattern.test(template)).toBe(false)
    }
  })

  test("session-ui-store synthetic plan prompt does not instruct fenced plan output", () => {
    const source = readFileSync(new URL("../sync/session-ui-store.ts", import.meta.url), "utf8")
    for (const pattern of FORBIDDEN_FENCE_PATTERNS) {
      expect(pattern.test(source)).toBe(false)
    }
  })
})

describe("clarifying-question prompts use the structured question tool", () => {
  test("planning and issue-review prompts tell assistants to batch structured questions", () => {
    const promptIds = ["plan.todo.instructions", "github.issue.review.instructions"]

    for (const id of promptIds) {
      const def = MAGIC_PROMPT_DEFINITIONS.find((d) => d.id === id)
      if (!def) throw new Error(`${id} definition missing`)
      expect(def.template).toContain("structured question tool")
      expect(def.template).toContain("questions[]")
      expect(def.template).toContain("Never ask clarifying questions as free-form chat text")
    }
  })

  test("planning prompts do not request final approval questions", () => {
    const promptIds = ["plan.todo.instructions"]

    for (const id of promptIds) {
      const def = MAGIC_PROMPT_DEFINITIONS.find((d) => d.id === id)
      if (!def) throw new Error(`${id} definition missing`)
      expect(/approval question/i.test(def.template)).toBe(false)
      expect(/approve this (?:design|plan)/i.test(def.template)).toBe(false)
      expect(def.template).toContain("the plan card provides the implementation action")
    }
  })
})

describe("plan task tracking prompts", () => {
  test("plan generation requires numbered phase headings", () => {
    const def = MAGIC_PROMPT_DEFINITIONS.find((entry) => entry.id === "plan.todo.instructions")
    if (!def) throw new Error("plan.todo.instructions definition missing")

    expect(def.template).toContain("### Phase 1: <name>")
    expect(def.template).toContain("numbered actionable tasks")
  })

  test("saved-plan implementation preserves a one-to-one phase todo list and N/N completion gate", () => {
    const def = MAGIC_PROMPT_DEFINITIONS.find((entry) => entry.id === "plan.implement.instructions")
    if (!def) throw new Error("plan.implement.instructions definition missing")

    expect(def.template).toContain("exactly one todo per plan task")
    expect(def.template).toContain("Prefix every todo with `Phase <number>: `")
    expect(def.template).toContain("do not remove, merge, reorder, cancel, add, or replace plan todos")
    expect(def.template).toContain("counter reaches N/N")
    expect(def.template).toContain("revised counter reaches N/N")
  })

  test("saved-plan implementation classifies deviations before changing scope", () => {
    const def = MAGIC_PROMPT_DEFINITIONS.find((entry) => entry.id === "plan.implement.instructions")
    if (!def) throw new Error("plan.implement.instructions definition missing")

    expect(def.template).toContain("A change the user's request or the approved plan already requires (including its migrations) is not a deviation and never needs a question.")
    expect(def.template).toContain("Class 1 (continue without asking)")
    expect(def.template).toContain("Class 2 (ask first)")
    expect(def.template).toContain("to data/schema meaning beyond what the approved plan or request already requires")
    expect(def.template).toContain("security-definer functions")
    expect(def.template).toContain("RLS policies or grants")
    expect(def.template).toContain("destructive statements on existing user data (DROP / DELETE / TRUNCATE / type-narrowing on populated tables)")
    expect(def.template).toContain("external calls (email, webhooks, payments)")
    expect(def.template).toContain("Planned migrations are not a tripwire")
    expect(def.template).toContain("If unsure whether the plan already covers it, re-read the plan and the user's request; ask only if it is genuinely outside both.")
    expect(def.template).not.toContain("If the classification is uncertain, treat it as Class 2")
    expect(def.template).not.toContain("destructive data statements")
    expect(def.template).toContain("`Deviation: <step> → <change>. Why: … Still delivers: <approved outcome>`")
    expect(def.template).toContain("is a deviation to classify, not a blocker")
    expect(def.template).not.toContain("low-risk related adjustment")
    expect(def.template).not.toContain("plan-gap rules")
  })

  test("Class 2 deviations route through a resumable, explained structured question", () => {
    const def = MAGIC_PROMPT_DEFINITIONS.find((entry) => entry.id === "plan.implement.instructions")
    if (!def) throw new Error("plan.implement.instructions definition missing")

    expect(def.template).toContain("Ask exactly one question through the structured question tool")
    expect(def.template).toContain("Use the header `Plan deviation`")
    expect(def.template).toContain("line 1 is the question itself")
    for (const line of ["What changes:", "Why:", "For end users:", "Security & data:", "Reversibility:", "If we keep the original plan:"]) {
      expect(def.template).toContain("`" + line + "`")
    }
    expect(def.template).toContain("`Approve deviation (Recommended)`")
    expect(def.template).toContain("`Keep original plan`")
    expect(def.template).toContain("`Something else` (a custom answer is allowed)")
    expect(def.template).toContain("While the question is pending, do not emit a completion or blocked response")
    expect(def.template).toContain("skip the question, or give an ambiguous answer")
    expect(def.template).not.toContain("Use the header `Plan gap`")
    expect(def.template).not.toContain("`Apply adjustment and continue (Recommended)`")
    expect(def.template).not.toContain("stop, state exactly what is broken and why")
  })

  test("recorded and approved deviations are appended to the plan and reconcile todos before resuming", () => {
    const def = MAGIC_PROMPT_DEFINITIONS.find((entry) => entry.id === "plan.implement.instructions")
    if (!def) throw new Error("plan.implement.instructions definition missing")

    expect(def.template).toContain("under `## Deviations`")
    expect(def.template).toContain("`N. [Class 1 | Class 2 approved] <step> → <change>. Why: … Still delivers: …`")
    expect(def.template).toContain("record the deviation in this same plan file first, reconcile the todos, implement it, and resume in the same session")
    expect(def.template).toContain("Todo reconciliation after a recorded Class 1 or approved Class 2 deviation")
    expect(def.template).toContain("Preserve the wording, identity, and status of unchanged tasks")
    expect(def.template).toContain("add newly approved tasks in plan order")
    expect(def.template).toContain("reopen any completed task whose work or verification is affected")
  })
})
