import { describe, expect, test } from "bun:test"
import type { PermissionRequest, QuestionRequest, Session } from "@opencode-ai/sdk/v2/client"
import type { State } from "@/sync/types"
import { INITIAL_STATE } from "@/sync/types"
import {
  collectVisibleSessionIdsForBlockingRequests,
  createScopedBlockingRequestsSelector,
  hasScopedPendingQuestions,
} from "./lib/blockingRequests"

const session = (id: string, parentID?: string): Session => ({
  id,
  parentID,
  title: id,
  time: { created: 1, updated: 1 },
  version: "1",
} as Session)

const question = (id: string, sessionID: string): QuestionRequest => ({
  id,
  sessionID,
  questions: [{ header: "Q", question: "Continue?", options: [{ label: "Yes", description: "" }] }],
} as QuestionRequest)

const permission = (id: string, sessionID: string): PermissionRequest => ({
  id,
  sessionID,
  permission: "bash",
  patterns: [],
  metadata: {},
  always: [],
} as PermissionRequest)

const state = (overrides: Partial<State>): State => ({
  ...INITIAL_STATE,
  ...overrides,
})

describe("blocking request session scoping", () => {
  test("includes child-session requests only when the child relationship is known", () => {
    expect(collectVisibleSessionIdsForBlockingRequests([
      session("parent"),
      session("child", "parent"),
    ], "parent")).toEqual(["parent", "child"])

    expect(collectVisibleSessionIdsForBlockingRequests([
      session("parent"),
      session("orphan"),
    ], "parent")).toEqual(["parent"])
  })

  test("selects current-session question and permission requests even with no messages", () => {
    const selector = createScopedBlockingRequestsSelector("ses_a")
    const selected = selector(state({
      session: [session("ses_a")],
      message: {},
      part: {},
      question: { ses_a: [question("que_1", "ses_a")] },
      permission: { ses_a: [permission("perm_1", "ses_a")] },
    }))

    expect(selected.questions.map((entry) => entry.id)).toEqual(["que_1"])
    expect(selected.permissions.map((entry) => entry.id)).toEqual(["perm_1"])
  })

  test("selects external-directory permissions for the active session", () => {
    const selector = createScopedBlockingRequestsSelector("ses_a")
    const externalPermission = {
      ...permission("perm_external", "ses_a"),
      permission: "external_directory",
      patterns: ["/Users/dev/Documents/private-note.md"],
      metadata: { path: "/Users/dev/Documents/private-note.md" },
      always: ["/Users/dev/Documents/*"],
    } as PermissionRequest

    const selected = selector(state({
      session: [session("ses_a")],
      permission: { ses_a: [externalPermission] },
    }))

    expect(selected.permissions).toEqual([externalPermission])
  })

  test("selects external-directory permissions from known child sessions in the parent chat", () => {
    const selector = createScopedBlockingRequestsSelector("parent")
    const childPermission = {
      ...permission("perm_child_external", "child"),
      permission: "external_directory",
      patterns: ["/Users/dev/Documents/private-note.md"],
      metadata: { path: "/Users/dev/Documents/private-note.md" },
      always: ["/Users/dev/Documents/*"],
    } as PermissionRequest

    const selected = selector(state({
      session: [session("parent"), session("child", "parent")],
      permission: { child: [childPermission] },
    }))

    expect(selected.permissions).toEqual([childPermission])
  })

  test("surfaces child-session multiple-choice questions in the parent chat", () => {
    const selector = createScopedBlockingRequestsSelector<PermissionRequest, QuestionRequest>("parent")
    const childQuestion = {
      ...question("que_child", "child"),
      questions: [{
        header: "Decision",
        question: "Which path should the subagent take?",
        options: [
          { label: "Narrow fix (Recommended)", description: "Keep the change scoped." },
          { label: "Broad cleanup", description: "Refactor nearby code too." },
        ],
      }],
    } as QuestionRequest

    const selected = selector(state({
      session: [session("parent"), session("child", "parent")],
      question: { child: [childQuestion] },
    }))

    expect(selected.questions).toEqual([childQuestion])
    expect(selected.questions[0].questions[0].options.map((option) => option.label)).toEqual([
      "Narrow fix (Recommended)",
      "Broad cleanup",
    ])
  })

  test("returns the same reference for unrelated message or status changes", () => {
    const selector = createScopedBlockingRequestsSelector("ses_a")
    const baseQuestion = question("que_1", "ses_a")
    const first = selector(state({
      session: [session("ses_a")],
      question: { ses_a: [baseQuestion] },
    }))
    const second = selector(state({
      session: [session("ses_a")],
      question: { ses_a: [baseQuestion] },
      message: { other: [{ id: "msg_other", sessionID: "other", role: "assistant" } as never] },
      session_status: { other: { type: "busy" } as never },
    }))

    expect(second).toBe(first)
  })
})

describe("hasScopedPendingQuestions", () => {
  test("is false when no question is pending anywhere", () => {
    expect(hasScopedPendingQuestions(state({ session: [session("ses_a")] }), "ses_a")).toBe(false)
    expect(hasScopedPendingQuestions(state({ question: { ses_a: [] } }), "ses_a")).toBe(false)
  })

  test("covers the session itself and its descendants, not unrelated sessions", () => {
    const tree = {
      session: [session("ses_a"), session("ses_child", "ses_a"), session("ses_grandchild", "ses_child"), session("ses_other")],
    }
    expect(hasScopedPendingQuestions(state({ ...tree, question: { ses_a: [question("que_1", "ses_a")] } }), "ses_a")).toBe(true)
    expect(hasScopedPendingQuestions(state({ ...tree, question: { ses_grandchild: [question("que_2", "ses_grandchild")] } }), "ses_a")).toBe(true)
    expect(hasScopedPendingQuestions(state({ ...tree, question: { ses_other: [question("que_3", "ses_other")] } }), "ses_a")).toBe(false)
    expect(hasScopedPendingQuestions(state({ ...tree, question: { ses_a: [question("que_1", "ses_a")] } }), null)).toBe(false)
  })

  test("ignores orphaned questions whose turn already stopped", () => {
    const orphan = {
      ...question("que_dead", "ses_child"),
      tool: { messageID: "msg_dead", callID: "call_dead" },
    } as QuestionRequest
    const settledPart = { id: "prt", type: "tool", callID: "call_dead", state: { status: "error" } } as never
    const tree = { session: [session("ses_a"), session("ses_child", "ses_a")] }
    expect(hasScopedPendingQuestions(state({
      ...tree,
      question: { ses_child: [orphan] },
      part: { msg_dead: [settledPart] },
    }), "ses_a")).toBe(false)
    expect(hasScopedPendingQuestions(state({
      ...tree,
      question: { ses_child: [orphan] },
      part: { msg_dead: [{ ...(settledPart as object), state: { status: "running" } } as never] },
    }), "ses_a")).toBe(true)
  })
})
