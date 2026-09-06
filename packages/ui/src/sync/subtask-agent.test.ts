import { describe, expect, test } from "bun:test"
import {
  createLatestUserChoiceSelector,
  resolveLatestUserChoiceFromMessages,
  resolveSubtaskAgentFromMessages,
  resolveUserMessageVariant,
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
  test("restores the native provider-default sentinel without treating it as inheritance", () => {
    expect(resolveLatestUserChoiceFromMessages([
      { id: "msg_default", role: "user", agent: "Builder", model: { providerID: "openai", modelID: "gpt", variant: "" }, variant: "high" },
    ])?.variant).toBeNull()
    expect(resolveLatestUserChoiceFromMessages([
      { id: "msg_legacy", role: "user", agent: "Builder", model: { providerID: "openai", modelID: "gpt" } },
    ])?.variant).toBeUndefined()
  })

  test("canonical thinking takes precedence over conflicting legacy records", () => {
    expect(resolveUserMessageVariant({ model: { variant: "low" }, variant: "high" })).toBe("low")
    expect(resolveUserMessageVariant({ model: { variant: null }, variant: "high" })).toBeNull()
    expect(resolveUserMessageVariant({ model: { variant: "" }, variant: "high" })).toBeNull()
    expect(resolveUserMessageVariant({ model: { variant: 42 }, variant: "high" })).toBeUndefined()
    expect(resolveUserMessageVariant({ model: {}, variant: "high" })).toBe("high")
    expect(resolveUserMessageVariant({ variant: "" })).toBeNull()
  })

  for (const { expected, ...fields } of [
    { model: { providerID: "openai", modelID: "gpt", variant: "" }, expected: null },
    { model: { providerID: "openai", modelID: "gpt", variant: "high" }, expected: "high" },
    { model: { providerID: "openai", modelID: "gpt" }, variant: "", expected: null },
    { model: { providerID: "openai", modelID: "gpt" }, variant: "high", expected: "high" },
  ]) test(`retains the real user choice across a native compaction marker: ${JSON.stringify(fields)}`, () => {
    const messages = [
      { id: "human", role: "user", agent: "builder", ...fields },
      { id: "compaction", role: "user", agent: "compaction", model: { providerID: "other", modelID: "summary" } },
      { id: "summary", role: "assistant", agent: "compaction" },
    ]
    const choice = resolveLatestUserChoiceFromMessages(messages, id => id === "compaction" ? [{ type: "compaction" }] : [{ type: "text" }])
    expect(choice).toEqual({ id: "human", agent: "builder", providerID: "openai", modelID: "gpt", variant: expected })
  })

  test("a later real user without variant remains inheritance rather than borrowing an older choice", () => {
    expect(resolveLatestUserChoiceFromMessages([
      { id: "older", role: "user", model: { variant: "high" } },
      { id: "compaction", role: "user", model: {} },
      { id: "human", role: "user", model: {} },
    ], id => id === "compaction" ? [{ type: "compaction" }] : [{ type: "text" }])?.variant).toBeUndefined()
  })

  test("the selected choice is stable through assistant deltas and late compaction-part delivery", () => {
    const select = createLatestUserChoiceSelector("session")
    const human = { id: "human", role: "user", agent: "builder", model: { providerID: "openai", modelID: "gpt", variant: "" } }
    const state = {
      message: { session: [human, { id: "assistant", role: "assistant" }] },
      part: { human: [{ type: "text" as const }], assistant: [{ type: "text" as const }] },
    }
    const original = select(state)
    expect(original?.variant).toBeNull()
    expect(select({ ...state, part: { ...state.part, assistant: [{ type: "text" }] } })).toBe(original)

    const compacting = { ...state, message: { session: [...state.message.session, { id: "compaction", role: "user", model: { providerID: "openai", modelID: "gpt" } }] } }
    expect(select(compacting)).toBe(original)
    expect(select({ ...compacting, part: { ...state.part, compaction: [{ type: "compaction" }] } })).toBe(original)

    const next = { ...compacting, message: { session: [...compacting.message.session, { id: "next", role: "user", model: { variant: "high" } }] }, part: { ...state.part, compaction: [{ type: "compaction" as const }], next: [{ type: "text" as const }] } }
    expect(select(next)?.variant).toBe("high")
    expect(select(next)).toBe(select(next))
  })

})
