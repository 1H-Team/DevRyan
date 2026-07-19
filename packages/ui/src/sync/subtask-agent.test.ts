import { describe, expect, test } from "bun:test"
import { resolveSubtaskAgentFromMessages } from "./subtask-agent"

describe("resolveSubtaskAgentFromMessages", () => {
  test("keeps the original subtask agent after a later continuation used the wrong agent", () => {
    expect(resolveSubtaskAgentFromMessages([
      { role: "user", agent: "oracle" },
      { role: "assistant", agent: "oracle" },
      { role: "user", agent: "orchestrator" },
    ])).toBe("oracle")
  })

  test("supports legacy user messages that stored the agent as mode", () => {
    expect(resolveSubtaskAgentFromMessages([
      { role: "assistant", mode: "explorer" },
      { role: "user", mode: "explorer" },
    ])).toBe("explorer")
  })
})
