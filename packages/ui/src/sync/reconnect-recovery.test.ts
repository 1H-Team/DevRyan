import { describe, expect, test } from "bun:test"
import type { Message, Part, SessionStatus } from "@opencode-ai/sdk/v2/client"
import type { Session } from "@opencode-ai/sdk/v2"
import {
  captureSessionStatusBaseline,
  filterUnchangedSessionStatusCandidates,
  getActiveSessionRecoveryCooldownMs,
  getPendingToolInputStallFingerprint,
  getProviderInferenceStallFingerprint,
  getProviderStallFingerprint,
  getReconnectCandidateSessionIds,
  haveSamePendingToolInputStallFingerprint,
  haveSameProviderStallFingerprint,
  mergeAuthoritativeSessionStatuses,
  mergeRecoveredSessionStatuses,
  shouldRecoverStaleActiveSession,
  unwrapSdkResult,
} from "./reconnect-recovery"
import { INITIAL_STATE, type State } from "./types"

function createSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    title: id,
    time: { created: 1, updated: 1 },
    version: "1",
    ...overrides,
  } as Session
}

function createAssistantMessage(id: string, sessionID: string, completed?: number): Message {
  return {
    id,
    sessionID,
    role: "assistant",
    time: completed ? { created: 1, updated: 1, completed } : { created: 1, updated: 1 },
    parts: [],
  } as unknown as Message
}

function createPart(id: string, messageID: string): Part {
  return { id, messageID, sessionID: "active", type: "text", text: "done" } as Part
}

function createPendingToolPart(
  id: string,
  messageID: string,
  overrides: Record<string, unknown> = {},
): Part {
  return {
    id,
    messageID,
    sessionID: "active",
    callID: `call_${id}`,
    type: "tool",
    tool: "todowrite",
    state: { status: "pending", input: {}, raw: "" },
    ...overrides,
  } as Part
}

function createState(overrides: Partial<State> = {}): State {
  return {
    ...INITIAL_STATE,
    ...overrides,
  }
}

describe("getReconnectCandidateSessionIds", () => {
  test("keeps only candidates whose complete status contract matches the captured baseline", () => {
    const baseline = captureSessionStatusBaseline({
      stable: { type: "idle" } as SessionStatus,
      changed: { type: "retry", attempt: 1, message: "retrying", next: 100 } as SessionStatus,
    }, ["stable", "changed", "missing"])

    expect(filterUnchangedSessionStatusCandidates({
      current: {
        stable: { type: "idle" } as SessionStatus,
        changed: { type: "retry", attempt: 2, message: "retrying", next: 100 } as SessionStatus,
      },
      candidateSessionIds: ["stable", "changed", "missing"],
      baseline,
    })).toEqual(["stable", "missing"])
  })

  test("includes non-idle, incomplete assistant, and parent sessions", () => {
    const busyStatus = { type: "busy" } as SessionStatus

    expect(getReconnectCandidateSessionIds({
      session: [
        createSession("busy"),
        createSession("child", { parentID: "parent" }),
        createSession("parent"),
        createSession("incomplete"),
      ],
      session_status: { busy: busyStatus },
      message: {
        incomplete: [createAssistantMessage("m-1", "incomplete")],
      },
    }).sort()).toEqual(["busy", "incomplete", "parent"])
  })

  test("includes the currently viewed session even when it looks idle and complete", () => {
    expect(getReconnectCandidateSessionIds({
      session: [createSession("active")],
      session_status: { active: { type: "idle" } as SessionStatus },
      message: {
        active: [createAssistantMessage("m-1", "active", 1)],
      },
      part: {
        "m-1": [createPart("p-1", "m-1")],
      },
    }, {
      directory: "/repo",
      viewedSession: { directory: "/repo", sessionId: "active" },
    }).sort()).toContain("active")
  })

  test("includes completed assistant sessions when the latest assistant parts are missing", () => {
    expect(getReconnectCandidateSessionIds({
      session: [createSession("blank")],
      session_status: { blank: { type: "idle" } as SessionStatus },
      message: {
        blank: [createAssistantMessage("m-1", "blank", 1)],
      },
      part: {},
    })).toEqual(["blank"])
  })

  test("does not include a viewed session from another directory", () => {
    expect(getReconnectCandidateSessionIds({
      session: [createSession("active")],
      session_status: { active: { type: "idle" } as SessionStatus },
      message: {
        active: [createAssistantMessage("m-1", "active", 1)],
      },
      part: {
        "m-1": [createPart("p-1", "m-1")],
      },
    }, {
      directory: "/repo-a",
      viewedSession: { directory: "/repo-b", sessionId: "active" },
    }).sort()).not.toContain("active")
  })

  test("merges idle only from authoritative server status", () => {
    const current = {
      active: { type: "busy" },
      untouched: { type: "busy" },
    } as Record<string, SessionStatus>

    expect(mergeAuthoritativeSessionStatuses({
      current,
      candidateSessionIds: ["active", "untouched"],
      authoritative: {
        active: { type: "idle" },
      },
    })).toEqual({
      active: { type: "idle" },
      untouched: { type: "busy" },
    })
  })

  test("settles missing authoritative status from a terminal trailing assistant message", () => {
    const state = createState({
      session: [createSession("active")],
      session_status: { active: { type: "busy" } as SessionStatus },
      message: {
        active: [createAssistantMessage("m-1", "active", 2)],
      },
      part: {
        "m-1": [createPart("p-1", "m-1")],
      },
    })

    expect(mergeRecoveredSessionStatuses({
      current: state.session_status,
      candidateSessionIds: ["active"],
      authoritative: {},
      state,
    })).toEqual({
      active: { type: "idle" },
    })
  })

  test("keeps missing authoritative status busy when no terminal assistant message proves completion", () => {
    const state = createState({
      session: [createSession("active")],
      session_status: { active: { type: "busy" } as SessionStatus },
      message: {
        active: [createAssistantMessage("m-1", "active")],
      },
    })

    expect(mergeRecoveredSessionStatuses({
      current: state.session_status,
      candidateSessionIds: ["active"],
      authoritative: {},
      state,
    })).toBe(state.session_status)
  })

  test("preserves SDK response status when wrapping transient errors", () => {
    expect(() => unwrapSdkResult({
      error: { message: "OpenCode API unavailable" },
      response: { status: 503 },
    }, "session.messages")).toThrow("session.messages failed (503): OpenCode API unavailable")

    expect(() => unwrapSdkResult({
      error: { error: "Directory is outside your assigned workspace" },
      response: { status: 403 },
    }, "config.providers")).toThrow(
      "config.providers failed (403): Directory is outside your assigned workspace",
    )

    try {
      unwrapSdkResult({
        error: "OpenCode API unavailable",
        response: { status: 503 },
      }, "session.messages")
    } catch (error) {
      expect((error as Error & { status?: number }).status).toBe(503)
    }
  })

  test("recognizes only an empty pending trailing tool call as a stall candidate", () => {
    const state = createState({
      session: [createSession("active")],
      session_status: { active: { type: "busy" } as SessionStatus },
      message: {
        active: [{
          ...createAssistantMessage("assistant-1", "active"),
          parentID: "user-1",
        } as Message],
      },
      part: {
        "assistant-1": [createPendingToolPart("tool-1", "assistant-1")],
      },
    })

    expect(getPendingToolInputStallFingerprint({ state, sessionID: "active" })).toEqual({
      kind: "tool-input",
      sessionID: "active",
      assistantMessageID: "assistant-1",
      anchorUserMessageID: "user-1",
      partID: "tool-1",
      callID: "call_tool-1",
      tool: "todowrite",
    })
  })

  test("recognizes only the initial empty inference shell as an automatic stall candidate", () => {
    const makeState = (trailingPart: Part, parts?: Part[]) => createState({
      session: [createSession("active")],
      session_status: { active: { type: "busy" } as SessionStatus },
      message: {
        active: [{
          ...createAssistantMessage("assistant-1", "active"),
          parentID: "user-1",
        } as Message],
      },
      part: {
        "assistant-1": parts ?? [
          {
            id: "step-1",
            messageID: "assistant-1",
            sessionID: "active",
            type: "step-start",
          } as Part,
          trailingPart,
        ],
      },
    })
    const emptyReasoning = {
      id: "reasoning-1",
      messageID: "assistant-1",
      sessionID: "active",
      type: "reasoning",
      text: "",
    } as Part

    expect(getProviderInferenceStallFingerprint({
      state: makeState(emptyReasoning),
      sessionID: "active",
    })).toEqual({
      kind: "inference",
      sessionID: "active",
      assistantMessageID: "assistant-1",
      anchorUserMessageID: "user-1",
      stepStartPartID: "step-1",
      partID: "reasoning-1",
      partType: "reasoning",
    })
    expect(getProviderStallFingerprint({
      state: makeState(emptyReasoning),
      sessionID: "active",
    })?.kind).toBe("inference")

    expect(getProviderInferenceStallFingerprint({
      state: makeState({ ...emptyReasoning, text: "Working" } as Part),
      sessionID: "active",
    })).toBeNull()
    expect(getProviderInferenceStallFingerprint({
      state: makeState(emptyReasoning, [
        createPart("text-1", "assistant-1"),
        {
          id: "step-1",
          messageID: "assistant-1",
          sessionID: "active",
          type: "step-start",
        } as Part,
        emptyReasoning,
      ]),
      sessionID: "active",
    })).toBeNull()
  })

  test("requires the same authoritative inference shell after a resync", () => {
    const makeState = (partID: string) => createState({
      session: [createSession("active")],
      session_status: { active: { type: "busy" } as SessionStatus },
      message: {
        active: [{
          ...createAssistantMessage("assistant-1", "active"),
          parentID: "user-1",
        } as Message],
      },
      part: {
        "assistant-1": [
          {
            id: "step-1",
            messageID: "assistant-1",
            sessionID: "active",
            type: "step-start",
          } as Part,
          {
            id: partID,
            messageID: "assistant-1",
            sessionID: "active",
            type: "reasoning",
            text: "",
          } as Part,
        ],
      },
    })
    const first = getProviderInferenceStallFingerprint({ state: makeState("reasoning-1"), sessionID: "active" })
    const same = getProviderInferenceStallFingerprint({ state: makeState("reasoning-1"), sessionID: "active" })
    const changed = getProviderInferenceStallFingerprint({ state: makeState("reasoning-2"), sessionID: "active" })

    expect(haveSameProviderStallFingerprint(first, same)).toBe(true)
    expect(haveSameProviderStallFingerprint(first, changed)).toBe(false)
  })

  test("rejects partial input, running tools, retries, blocking requests, and managed dispatches", () => {
    const stalledState = () => createState({
      session: [createSession("active")],
      session_status: { active: { type: "busy" } as SessionStatus },
      message: {
        active: [{
          ...createAssistantMessage("assistant-1", "active"),
          parentID: "user-1",
        } as Message],
      },
      part: {
        "assistant-1": [createPendingToolPart("tool-1", "assistant-1")],
      },
    })

    const partial = stalledState()
    partial.part["assistant-1"] = [createPendingToolPart("tool-1", "assistant-1", {
      state: { status: "pending", input: {}, raw: "{" },
    })]
    expect(getPendingToolInputStallFingerprint({ state: partial, sessionID: "active" })).toBeNull()

    const running = stalledState()
    running.part["assistant-1"] = [createPendingToolPart("tool-1", "assistant-1", {
      state: { status: "running", input: {} },
    })]
    expect(getPendingToolInputStallFingerprint({ state: running, sessionID: "active" })).toBeNull()

    const retrying = stalledState()
    retrying.session_status.active = { type: "retry", attempt: 1, message: "again", next: 1 } as SessionStatus
    expect(getPendingToolInputStallFingerprint({ state: retrying, sessionID: "active" })).toBeNull()

    const blocked = stalledState()
    blocked.question = { active: [{ id: "question-1" }] as State["question"][string] }
    expect(getPendingToolInputStallFingerprint({ state: blocked, sessionID: "active" })).toBeNull()

    const managed = stalledState()
    managed.part["assistant-1"] = [createPendingToolPart("tool-1", "assistant-1", { tool: "devryan_task" })]
    expect(getPendingToolInputStallFingerprint({ state: managed, sessionID: "active" })).toBeNull()

    const child = stalledState()
    child.session = [createSession("active", { parentID: "parent" })]
    expect(getPendingToolInputStallFingerprint({ state: child, sessionID: "active" })).toBeNull()
  })

  test("requires the same authoritative call identity after a resync", () => {
    const makeState = (partID: string) => createState({
      session: [createSession("active")],
      session_status: { active: { type: "busy" } as SessionStatus },
      message: {
        active: [{
          ...createAssistantMessage("assistant-1", "active"),
          parentID: "user-1",
        } as Message],
      },
      part: {
        "assistant-1": [createPendingToolPart(partID, "assistant-1")],
      },
    })
    const first = getPendingToolInputStallFingerprint({ state: makeState("tool-1"), sessionID: "active" })
    const same = getPendingToolInputStallFingerprint({ state: makeState("tool-1"), sessionID: "active" })
    const changed = getPendingToolInputStallFingerprint({ state: makeState("tool-2"), sessionID: "active" })

    expect(haveSamePendingToolInputStallFingerprint(first, same)).toBe(true)
    expect(haveSamePendingToolInputStallFingerprint(first, changed)).toBe(false)
  })

  test("does not recover idle active sessions", () => {
    expect(shouldRecoverStaleActiveSession({
      status: { type: "idle" } as SessionStatus,
      now: 30_000,
      lastStatusEventAt: 0,
      lastRecoveryAt: undefined,
    })).toBe(false)
  })

  test("recovers stale busy active sessions after the threshold", () => {
    expect(shouldRecoverStaleActiveSession({
      status: { type: "busy" } as SessionStatus,
      now: 21_000,
      lastStatusEventAt: 0,
      lastRecoveryAt: undefined,
    })).toBe(true)
  })

  test("fresh status events and cooldown suppress active-session recovery", () => {
    expect(shouldRecoverStaleActiveSession({
      status: { type: "busy" } as SessionStatus,
      now: 21_000,
      lastStatusEventAt: 5_000,
      lastRecoveryAt: undefined,
    })).toBe(false)

    expect(shouldRecoverStaleActiveSession({
      status: { type: "retry", attempt: 1, message: "again", next: 30_000 } as SessionStatus,
      now: 40_000,
      lastStatusEventAt: 0,
      lastRecoveryAt: 30_000,
    })).toBe(false)
  })

  test("uses fresh output events to suppress active-session recovery while streaming continues", () => {
    expect(shouldRecoverStaleActiveSession({
      status: { type: "busy" } as SessionStatus,
      now: 40_000,
      lastStatusEventAt: 0,
      lastOutputEventAt: 35_000,
      lastRecoveryAt: undefined,
    })).toBe(false)
  })

  test("does not treat duplicate busy status events as semantic model progress", () => {
    expect(shouldRecoverStaleActiveSession({
      status: { type: "busy" } as SessionStatus,
      now: 40_000,
      lastStatusEventAt: 35_000,
      lastOutputEventAt: 0,
      lastRecoveryAt: undefined,
    })).toBe(true)

    expect(shouldRecoverStaleActiveSession({
      status: { type: "retry", attempt: 2, message: "again", next: 45_000 } as SessionStatus,
      now: 40_000,
      lastStatusEventAt: 35_000,
      lastOutputEventAt: 0,
      lastRecoveryAt: undefined,
    })).toBe(false)
  })

  test("recovers active sessions when both status and output events are stale", () => {
    expect(shouldRecoverStaleActiveSession({
      status: { type: "retry", attempt: 1, message: "again", next: 45_000 } as SessionStatus,
      now: 40_000,
      lastStatusEventAt: 0,
      lastOutputEventAt: 10_000,
      lastRecoveryAt: undefined,
    })).toBe(true)
  })

  test("continues probing an unchanged activity epoch after the cooldown", () => {
    expect(shouldRecoverStaleActiveSession({
      status: { type: "busy" } as SessionStatus,
      now: 120_000,
      lastStatusEventAt: 10_000,
      lastOutputEventAt: 20_000,
      lastRecoveryAt: 30_000,
      cooldownMs: 15_000,
    })).toBe(true)

    expect(shouldRecoverStaleActiveSession({
      status: { type: "busy" } as SessionStatus,
      now: 40_000,
      lastStatusEventAt: 10_000,
      lastOutputEventAt: 20_000,
      lastRecoveryAt: 30_000,
      cooldownMs: 15_000,
    })).toBe(false)
  })

  test("backs off failed recovery probes with a bounded cooldown", () => {
    expect(getActiveSessionRecoveryCooldownMs(0)).toBe(15_000)
    expect(getActiveSessionRecoveryCooldownMs(1)).toBe(30_000)
    expect(getActiveSessionRecoveryCooldownMs(2)).toBe(60_000)
    expect(getActiveSessionRecoveryCooldownMs(20)).toBe(60_000)
  })
})
