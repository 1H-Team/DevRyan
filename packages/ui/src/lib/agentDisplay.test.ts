import { describe, expect, test } from "bun:test"

import { formatAgentDisplayName } from "./agentDisplay"

describe("formatAgentDisplayName", () => {
  test("capitalizes canonical primary agent names", () => {
    expect(formatAgentDisplayName("builder")).toBe("Builder")
    expect(formatAgentDisplayName("orchestrator")).toBe("Orchestrator")
  })

  test("formats compound agent names without changing their stored value", () => {
    expect(formatAgentDisplayName("release_review-agent")).toBe("Release Review Agent")
  })
})
