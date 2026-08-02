import { describe, expect, test } from "bun:test"
import type { Message, Part, SessionStatus } from "@opencode-ai/sdk/v2/client"

import type { ProviderRecoveryInput } from "@/stores/useProviderRecoveryStore"
import type { ProviderStallRecord } from "@/stores/useProviderStallStore"
import { INITIAL_STATE, type State } from "./types"
import { stopStalledProviderAndOfferRecovery } from "./provider-stall-recovery"

const record: ProviderStallRecord = {
  kind: "tool-input",
  sessionID: "ses_1",
  directory: "/workspace",
  assistantMessageID: "msg_assistant",
  anchorUserMessageID: "msg_user",
  partID: "part_tool",
  callID: "call_tool",
  tool: "todowrite",
  confirmedAt: 1_000,
  pending: true,
  actionError: null,
}

const inferenceRecord: ProviderStallRecord = {
  kind: "inference",
  sessionID: "ses_1",
  directory: "/workspace",
  assistantMessageID: "msg_assistant",
  anchorUserMessageID: "msg_user",
  stepStartPartID: "part_step",
  partID: "part_reasoning",
  partType: "reasoning",
  confirmedAt: 1_000,
  pending: true,
  actionError: null,
}

const createState = (partID = "part_tool"): State => ({
  ...INITIAL_STATE,
  session: [{
    id: "ses_1",
    title: "Root session",
    version: "1",
    time: { created: 1, updated: 2 },
  } as State["session"][number]],
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
      tool: "todowrite",
      state: { status: "pending", input: {}, raw: "" },
    } as Part],
  },
})

const createInferenceState = (partID = "part_reasoning"): State => ({
  ...createState(),
  part: {
    msg_assistant: [
      {
        id: "part_step",
        messageID: "msg_assistant",
        sessionID: "ses_1",
        type: "step-start",
      } as Part,
      {
        id: partID,
        messageID: "msg_assistant",
        sessionID: "ses_1",
        type: "reasoning",
        text: "",
      } as Part,
    ],
  },
})

describe("stalled provider recovery", () => {
  test("rechecks authoritative identity before aborting and offering manual recovery", async () => {
    let abortCalls = 0
    const offeredRecoveries: ProviderRecoveryInput[] = []

    const outcome = await stopStalledProviderAndOfferRecovery(record, {
      resyncSession: () => Promise.resolve(),
      getState: () => createState(),
      isCurrent: () => true,
      abort: () => {
        abortCalls += 1
        return Promise.resolve(true)
      },
      offerRecovery: (recovery) => offeredRecoveries.push(recovery),
    })

    expect(outcome).toBe("recovery-offered")
    expect(abortCalls).toBe(1)
    expect(offeredRecoveries[0]).toEqual({
      sessionId: "ses_1",
      directory: "/workspace",
      anchorUserMessageId: "msg_user",
      reason: "The provider stopped responding while preparing a tool call.",
      providerId: "openai",
      modelId: "gpt-5.6-sol",
      variant: null,
      agent: "builder",
      createdAt: offeredRecoveries[0]?.createdAt,
    })
  })

  test("leaves a resumed or replaced tool stream running", async () => {
    let abortCalls = 0

    const outcome = await stopStalledProviderAndOfferRecovery(record, {
      resyncSession: () => Promise.resolve(),
      getState: () => createState("part_new"),
      isCurrent: () => true,
      abort: () => {
        abortCalls += 1
        return Promise.resolve(true)
      },
      offerRecovery: () => undefined,
    })

    expect(outcome).toBe("stream-resumed")
    expect(abortCalls).toBe(0)
  })

  test("stops an unchanged empty inference shell and offers recovery without resending", async () => {
    let abortCalls = 0
    const offeredRecoveries: ProviderRecoveryInput[] = []

    const outcome = await stopStalledProviderAndOfferRecovery(inferenceRecord, {
      resyncSession: () => Promise.resolve(),
      getState: () => createInferenceState(),
      isCurrent: () => true,
      abort: () => {
        abortCalls += 1
        return Promise.resolve(true)
      },
      offerRecovery: (recovery) => offeredRecoveries.push(recovery),
    })

    expect(outcome).toBe("recovery-offered")
    expect(abortCalls).toBe(1)
    expect(offeredRecoveries[0]).toEqual({
      sessionId: "ses_1",
      directory: "/workspace",
      anchorUserMessageId: "msg_user",
      reason: "The provider stopped responding before producing a response.",
      providerId: "openai",
      modelId: "gpt-5.6-sol",
      variant: null,
      agent: "builder",
      createdAt: offeredRecoveries[0]?.createdAt,
    })
  })

  test("leaves a changed inference shell running", async () => {
    let abortCalls = 0
    const outcome = await stopStalledProviderAndOfferRecovery(inferenceRecord, {
      resyncSession: () => Promise.resolve(),
      getState: () => createInferenceState("part_new"),
      isCurrent: () => true,
      abort: () => {
        abortCalls += 1
        return Promise.resolve(true)
      },
      offerRecovery: () => undefined,
    })

    expect(outcome).toBe("stream-resumed")
    expect(abortCalls).toBe(0)
  })

  test("does not abort after a semantic event clears stall ownership", async () => {
    let abortCalls = 0

    const outcome = await stopStalledProviderAndOfferRecovery(record, {
      resyncSession: () => Promise.resolve(),
      getState: () => createState(),
      isCurrent: () => false,
      abort: () => {
        abortCalls += 1
        return Promise.resolve(true)
      },
      offerRecovery: () => undefined,
    })

    expect(outcome).toBe("stream-resumed")
    expect(abortCalls).toBe(0)
  })

  test("keeps the action visible when the abort is not confirmed", async () => {
    let thrown: unknown
    try {
      await stopStalledProviderAndOfferRecovery(record, {
        resyncSession: () => Promise.resolve(),
        getState: () => createState(),
        isCurrent: () => true,
        abort: () => Promise.resolve(false),
        offerRecovery: () => undefined,
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown instanceof Error ? thrown.message : String(thrown)).toContain("could not confirm")
  })
})
