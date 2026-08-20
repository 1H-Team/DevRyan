import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2"

import { getContextUsageFromMessages } from "@/stores/utils/contextUsageUtils"
import { resolveModelContextCapacity } from "@/stores/utils/modelContextCapacity"

import { buildSessionMessageRecordsSnapshot } from "./sync-context"
import { INITIAL_STATE, type State } from "./types"

const SESSION_ID = "ses_context_projection"
const capacity = resolveModelContextCapacity({ limit: { context: 10_000 } })

const assistant = (id: string, tokens: Record<string, unknown>): Message => ({
  id,
  sessionID: SESSION_ID,
  role: "assistant",
  providerID: "openai",
  modelID: "gpt-context-test",
  time: { created: 1 },
  tokens,
} as unknown as Message)

const state = (messages: Message[], parts: Record<string, Part[]> = {}): State => ({
  ...INITIAL_STATE,
  status: "complete",
  message: { [SESSION_ID]: messages },
  part: parts,
})

describe("composer context usage projection", () => {
  test("reacts to terminal tokens without subscribing to streaming text and retains completion across a new shell", () => {
    const firstShell = assistant("msg_1", {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    })
    const firstTurnMessages = [firstShell]
    const initial = buildSessionMessageRecordsSnapshot(
      state(firstTurnMessages),
      SESSION_ID,
      undefined,
      { contextUsagePartsOnly: true },
    )
    expect(getContextUsageFromMessages(initial.list, capacity)).toBeNull()

    const streamingText = { id: "text-1", type: "text", text: "working" } as Part
    const textOnly = buildSessionMessageRecordsSnapshot(
      state(firstTurnMessages, { msg_1: [streamingText] }),
      SESSION_ID,
      initial,
      { contextUsagePartsOnly: true },
    )
    expect(textOnly).toBe(initial)

    const terminalPart = {
      id: "finish-1",
      type: "step-finish",
      tokens: { input: 800, output: 75, reasoning: 25, cache: { read: 200, write: 50 } },
    } as unknown as Part
    const terminal = buildSessionMessageRecordsSnapshot(
      state(firstTurnMessages, { msg_1: [streamingText, terminalPart] }),
      SESSION_ID,
      textOnly,
      { contextUsagePartsOnly: true },
    )
    expect(terminal).not.toBe(textOnly)
    expect(getContextUsageFromMessages(terminal.list, capacity)?.activeInputTokens).toBe(1_050)

    const completed = {
      ...firstShell,
      time: { created: 1, completed: 2 },
      finish: "stop",
      tokens: { total: 1_150, input: 800, output: 75, reasoning: 25, cache: { read: 200, write: 50 } },
    } as Message
    const completedSnapshot = buildSessionMessageRecordsSnapshot(
      state([completed], { msg_1: [streamingText, terminalPart] }),
      SESSION_ID,
      terminal,
      { contextUsagePartsOnly: true },
    )
    expect(getContextUsageFromMessages(completedSnapshot.list, capacity)?.activeInputTokens).toBe(1_050)

    const nextShell = assistant("msg_2", {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    })
    const nextTurn = buildSessionMessageRecordsSnapshot(
      state([completed, nextShell], { msg_1: [terminalPart] }),
      SESSION_ID,
      completedSnapshot,
      { contextUsagePartsOnly: true },
    )
    expect(getContextUsageFromMessages(nextTurn.list, capacity)?.activeInputTokens).toBe(1_050)
  })

  test("drops pre-compaction measurements until a post-boundary terminal measurement arrives", () => {
    const measured = assistant("msg_old", {
      input: 2_000,
      output: 100,
      reasoning: 0,
      cache: { read: 500, write: 0 },
    })
    const compactMessage = {
      id: "msg_compact",
      sessionID: SESSION_ID,
      role: "user",
      time: { created: 2 },
    } as Message
    const compactionPart = { id: "compact-1", type: "compaction" } as Part
    const compacted = buildSessionMessageRecordsSnapshot(
      state([measured, compactMessage], { msg_compact: [compactionPart] }),
      SESSION_ID,
      undefined,
      { contextUsagePartsOnly: true },
    )
    expect(getContextUsageFromMessages(compacted.list, capacity)).toBeNull()

    const postCompact = assistant("msg_new", {
      input: 400,
      output: 20,
      reasoning: 0,
      cache: { read: 100, write: 0 },
    })
    const refreshed = buildSessionMessageRecordsSnapshot(
      state([measured, compactMessage, postCompact], { msg_compact: [compactionPart] }),
      SESSION_ID,
      compacted,
      { contextUsagePartsOnly: true },
    )
    expect(getContextUsageFromMessages(refreshed.list, capacity)?.activeInputTokens).toBe(500)
  })
})
