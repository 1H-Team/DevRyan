import { describe, expect, test } from "bun:test"
import type { Message, Part, TextPart } from "@opencode-ai/sdk/v2"
import { buildPlanImplementationRequestMarker } from "@/lib/messages/actionablePlan"
import { createSessionPlanSelectionSelector } from "./session-plan-selection"
import type { State } from "./types"

const user = (id: string): Message => ({
  id,
  role: "user",
  sessionID: "session",
  time: { created: 1 },
  agent: "orchestrator",
  model: { providerID: "openai", modelID: "gpt" },
})
const text = (messageID: string, content: string, synthetic = false): TextPart => ({
  id: `${messageID}-text`,
  sessionID: "session",
  messageID,
  type: "text",
  text: content,
  synthetic,
})
const plan = (messageID: string) => text(messageID, "User has requested to enter plan mode.", true)
const compaction = (messageID: string): Part => ({
  id: `${messageID}-compaction`,
  sessionID: "session",
  messageID,
  type: "compaction",
  auto: false,
})
type Fixture = Pick<State, "message" | "part">

describe("canonical session plan selection", () => {
  test("restores Plan after an ordinary reload without local recorded flags", () => {
    const select = createSessionPlanSelectionSelector("session")
    expect(select({ message: { session: [user("human")] }, part: { human: [plan("human")] } }))
      .toEqual({ messageID: "human", enabled: true })
  })

  test("keeps Plan through two native boundaries and automatic continuation", () => {
    const select = createSessionPlanSelectionSelector("session")
    const continuation = { ...text("continue", "Continue if you have next steps.", true), metadata: { compaction_continue: true } }
    expect(select({
      message: { session: ["human", "compact-1", "continue", "compact-2"].map(user) },
      part: { human: [plan("human")], "compact-1": [compaction("compact-1")], continue: [continuation], "compact-2": [compaction("compact-2")] },
    })).toEqual({ messageID: "human", enabled: true })
  })

  test("a real later non-Plan turn does not inherit an older Plan choice", () => {
    const select = createSessionPlanSelectionSelector("session")
    expect(select({
      message: { session: ["human", "compact", "work"].map(user) },
      part: { human: [plan("human")], compact: [compaction("compact")], work: [text("work", "Make the change.")] },
    })).toEqual({ messageID: "work", enabled: false })
  })

  test("Implement Plan overrides both recorded and synthetic planning signals", () => {
    const select = createSessionPlanSelectionSelector("session", () => true)
    const marker = buildPlanImplementationRequestMarker({ sourceSessionId: "session", sourceMessageId: "plan", planIndex: 0 })
    expect(select({
      message: { session: [user("approve")] },
      part: { approve: [plan("approve"), text("approve", marker, true)] },
    })).toEqual({ messageID: "approve", enabled: false })
  })

  test("uses the exact recorded user flag when older canonical metadata is missing", () => {
    const select = createSessionPlanSelectionSelector("session", id => id === "human")
    expect(select({
      message: { session: [user("human"), user("compact")] },
      part: { human: [text("human", "Prepare the plan.")], compact: [compaction("compact")] },
    })).toEqual({ messageID: "human", enabled: true })
  })

  test("waits for canonical parts and ignores unrelated streaming parts", () => {
    const select = createSessionPlanSelectionSelector("session")
    const state: Fixture = { message: { session: [user("human")] }, part: {} }
    expect(select(state)).toBeNull()
    const ready = { ...state, part: { human: [plan("human")] } }
    const choice = select(ready)
    expect(choice?.enabled).toBe(true)
    expect(select({ ...ready, part: { ...ready.part, assistant: [text("assistant", "Streaming")] } })).toBe(choice)
    expect(select({ ...ready, message: { session: [...ready.message.session] } })).toBe(choice)
  })

  test("does not mistake ordinary synthetic text or a forged continuation flag for native continuation", () => {
    const select = createSessionPlanSelectionSelector("session")
    for (const part of [
      text("work", "Implement the saved plan.", true),
      { ...text("work", "Continue normally."), metadata: { compaction_continue: true } },
    ]) {
      expect(select({ message: { session: [user("human"), user("work")] }, part: { human: [plan("human")], work: [part] } }))
        .toEqual({ messageID: "work", enabled: false })
    }
  })

  test("managed maintenance carries policy without becoming Plan selection authority", () => {
    const select = createSessionPlanSelectionSelector("session")
    for (const content of [
      "[devryan-provider-recovery:v1:task_fixture]\nCollect the completed result.",
      "[devryan-open-todo-continuation:v1]\nContinue the first open todo.",
      "Your turn ended with open todos. If a plan deviation stopped you, classify it (Class 1: note it and continue; Class 2: ask with the question tool) and continue from the first open todo. If everything is done, mark the todos complete and give the final summary.",
    ]) {
      const ready: Fixture = {
        message: { session: [user("human"), user("wake")] },
        part: { human: [plan("human")], wake: [text("wake", content, true)] },
      }
      expect(select(ready)).toEqual({ messageID: "human", enabled: true })
      expect(select({ ...ready, part: { ...ready.part, wake: [plan("wake"), ...ready.part.wake] } }))
        .toEqual({ messageID: "human", enabled: true })
    }
  })

  test("a human quoting a maintenance marker still expresses a new OFF choice", () => {
    const select = createSessionPlanSelectionSelector("session")
    expect(select({
      message: { session: [user("human"), user("quote")] },
      part: { human: [plan("human")], quote: [text("quote", "[devryan-provider-recovery:v1:task_fixture]\nExplain this marker.")] },
    })).toEqual({ messageID: "quote", enabled: false })
  })

  test("a valid Implement action wins even on a record with maintenance and stale Plan parts", () => {
    const select = createSessionPlanSelectionSelector("session", () => true)
    const marker = buildPlanImplementationRequestMarker({ sourceSessionId: "session", sourceMessageId: "source", planIndex: 0 })
    expect(select({
      message: { session: [user("human"), user("implement")] },
      part: {
        human: [plan("human")],
        implement: [plan("implement"), text("implement", "[devryan-provider-recovery:v1:task_fixture]", true), text("implement", marker, true)],
      },
    })).toEqual({ messageID: "implement", enabled: false })
  })

  test("missing newest parts defer instead of restoring an older OFF choice", () => {
    const select = createSessionPlanSelectionSelector("session")
    const state: Fixture = { message: { session: [user("older"), user("newer")] }, part: { older: [text("older", "Implement it.")] } }
    expect(select(state)).toBeNull()
    expect(select({ ...state, part: { ...state.part, newer: [plan("newer")] } }))
      .toEqual({ messageID: "newer", enabled: true })
  })
})
