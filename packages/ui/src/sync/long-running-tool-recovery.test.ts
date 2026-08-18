import { describe, expect, test } from "bun:test"
import type { Message, Part, SessionStatus } from "@opencode-ai/sdk/v2/client"

import type { LongRunningToolRecord } from "@/stores/useLongRunningToolStore"
import { INITIAL_STATE, type State } from "./types"
import { stopLongRunningTool } from "./long-running-tool-recovery"

const record: LongRunningToolRecord = {
  kind: "long-running-tool",
  sessionID: "ses_1",
  directory: "/workspace",
  assistantMessageID: "msg_assistant",
  anchorUserMessageID: "msg_user",
  partID: "part_tool",
  callID: "call_tool",
  tool: "ctx_execute",
  observedAt: 1_000,
  lastActivityAt: 1_000,
  confirmedAt: 301_000,
  diagnosticMarkedAt: 301_000,
  pending: true,
  actionError: null,
}

const createState = (partID = "part_tool", status = "running"): State => ({
  ...INITIAL_STATE,
  session: [{ id: "ses_1", title: "Root", version: "1", time: { created: 1, updated: 2 } } as State["session"][number]],
  session_status: { ses_1: { type: "busy" } as SessionStatus },
  message: {
    ses_1: [
      {
        id: "msg_user",
        sessionID: "ses_1",
        role: "user",
        time: { created: 1 },
        model: { providerID: "openai", modelID: "gpt-5.6-sol" },
        agent: "builder",
      } as Message,
      {
        id: "msg_assistant",
        sessionID: "ses_1",
        parentID: "msg_user",
        role: "assistant",
        time: { created: 2 },
      } as Message,
    ],
  },
  part: {
    msg_assistant: [{
      id: partID,
      callID: partID === "part_tool" ? "call_tool" : "call_new",
      messageID: "msg_assistant",
      sessionID: "ses_1",
      type: "tool",
      tool: "ctx_execute",
      state: { status, input: { language: "javascript", code: "console.log('ok')" } },
    } as unknown as Part],
  },
})

describe("long-running tool recovery", () => {
  test("rechecks exact authoritative identity before aborting", async () => {
    let abortCalls = 0
    const outcome = await stopLongRunningTool(record, {
      resyncSession: () => Promise.resolve(),
      getState: () => createState(),
      isCurrent: () => true,
      abort: () => {
        abortCalls += 1
        return Promise.resolve(true)
      },
    })

    expect(outcome).toBe("stopped")
    expect(abortCalls).toBe(1)
  })

  test("does not abort a completed or replaced call", async () => {
    let abortCalls = 0
    for (const state of [createState("part_new"), createState("part_tool", "completed")]) {
      const outcome = await stopLongRunningTool(record, {
        resyncSession: () => Promise.resolve(),
        getState: () => state,
        isCurrent: () => true,
        abort: () => {
          abortCalls += 1
          return Promise.resolve(true)
        },
      })
      expect(outcome).toBe("stream-resumed")
    }
    expect(abortCalls).toBe(0)
  })

  test("keeps the action available when abort is not confirmed", async () => {
    let rejection: unknown
    try {
      await stopLongRunningTool(record, {
        resyncSession: () => Promise.resolve(),
        getState: () => createState(),
        isCurrent: () => true,
        abort: () => Promise.resolve(false),
      })
    } catch (error) {
      rejection = error
    }

    expect(rejection instanceof Error ? rejection.message : "").toContain("could not confirm")
  })
})
