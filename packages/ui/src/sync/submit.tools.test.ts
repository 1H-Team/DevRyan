import { describe, expect, test } from "bun:test"

;(globalThis as typeof globalThis & { window?: Window & typeof globalThis }).window = {
  location: {
    href: "http://127.0.0.1:5180/",
    origin: "http://127.0.0.1:5180",
  },
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
} as unknown as Window & typeof globalThis

const { resolveSubmitPromptTools } = await import("./submit")

describe("alternate SDK prompt tool transport", () => {
  test("adds no tool overrides for Plan agent submissions", () => {
    expect(resolveSubmitPromptTools({
      agent: "plan",
      model: { providerID: "openai", modelID: "gpt-5.5" },
    })).toBe(undefined)
  })

  test("keeps provider-native delegation disabled for Orchestrator submissions", () => {
    expect(resolveSubmitPromptTools({
      agent: "orchestrator",
      model: { providerID: "openai", modelID: "gpt-5.5" },
    })).toEqual({ task: false, invalid: false })
  })
})
