import { describe, expect, test } from "bun:test"
import {
  resolveLatestUserChoiceFromMessages,
  resolveSubtaskAgentFromMessages,
} from "./subtask-agent"

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

  test("restores the recovered model and thinking from the latest user record", () => {
    const messages = [
      {
        id: "msg_original",
        role: "user",
        agent: "oracle",
        model: {
          providerID: "anthropic",
          modelID: "claude-opus-5",
          variant: "xhigh",
        },
      },
      { role: "assistant", agent: "oracle" },
      {
        id: "msg_recovery",
        role: "user",
        agent: "oracle",
        model: {
          providerID: "openai",
          modelID: "gpt-5.6",
          variant: "xhigh",
        },
      },
    ]

    expect(resolveSubtaskAgentFromMessages(messages)).toBe("oracle")
    expect(resolveLatestUserChoiceFromMessages(messages)).toEqual({
      id: "msg_recovery",
      agent: "oracle",
      providerID: "openai",
      modelID: "gpt-5.6",
      variant: "xhigh",
    })
  })

  test("supports the legacy top-level thinking variant on the latest user record", () => {
    expect(resolveLatestUserChoiceFromMessages([
      {
        id: "msg_legacy",
        role: "user",
        mode: "oracle",
        model: {
          providerID: "openai",
          modelID: "gpt-5.6",
        },
        variant: "high",
      },
    ])).toEqual({
      id: "msg_legacy",
      agent: "oracle",
      providerID: "openai",
      modelID: "gpt-5.6",
      variant: "high",
    })
  })
})
