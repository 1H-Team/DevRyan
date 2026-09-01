import { beforeEach, describe, expect, test } from "bun:test"
import {
  fetchMagicPromptOverrides,
  getDefaultMagicPromptTemplate,
  invalidateMagicPromptOverridesCache,
  MAGIC_PROMPT_DEFINITIONS,
  renderMagicPrompt,
} from "./magicPrompts"

const originalFetch = globalThis.fetch

describe("magic prompt catalog", () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch
    invalidateMagicPromptOverridesCache()
  })

  test("commit generation exposes the same two-section shape as PR generation", () => {
    const commitPromptIds = MAGIC_PROMPT_DEFINITIONS
      .filter((definition) => definition.id.startsWith("git.commit."))
      .map((definition) => definition.id)

    expect(commitPromptIds).toEqual([
      "git.commit.generate.visible",
      "git.commit.generate.instructions",
    ])

    const prPromptIds = MAGIC_PROMPT_DEFINITIONS
      .filter((definition) => definition.id.startsWith("git.pr.generate."))
      .map((definition) => definition.id)

    expect(prPromptIds).toEqual([
      "git.pr.generate.visible",
      "git.pr.generate.instructions",
    ])
  })

  test("deprecated commit prompt overrides are filtered from loaded payloads", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      version: 1,
      overrides: {
        "git.commit.draft.visible": "old draft visible",
        "git.commit.draft.instructions": "old draft instructions",
        "git.commit.plan.visible": "old plan visible",
        "git.commit.plan.instructions": "old plan instructions",
        "git.commit.generate.visible": "new commit visible",
        "git.pr.generate.visible": "pr visible",
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })

    const overrides = await fetchMagicPromptOverrides()

    expect(overrides).toEqual({
      "git.commit.generate.visible": "new commit visible",
      "git.pr.generate.visible": "pr visible",
    })
  })

  test("uses the concise Implement plan message without exposing the plan title", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      version: 1,
      overrides: {},
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })

    expect(getDefaultMagicPromptTemplate("plan.implement.visible")).toBe("Implement plan.")
    const rendered = await renderMagicPrompt("plan.implement.visible", {
      plan_title: "Fix auth email carryover",
    })
    expect(rendered).toBe("Implement plan.")
  })

  test("renders the host Implement Plan override for action consumers", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      version: 1,
      overrides: {
        "plan.implement.visible": "Use the approved implementation plan.",
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })

    const rendered = await renderMagicPrompt("plan.implement.visible", {
      plan_title: "A title that must not be appended",
    })
    expect(rendered).toBe("Use the approved implementation plan.")
  })
})
