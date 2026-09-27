import { describe, expect, test } from "bun:test"
import type { Part, QuestionRequest as SdkQuestionRequest } from "@opencode-ai/sdk/v2/client"
import type { QuestionRequest } from "@/types/question"
import { INITIAL_STATE, type State } from "@/sync/types"
import { computeOrphanedQuestionSignature } from "./useOrphanedQuestionKeys"

const request = (id: string, sessionID: string): QuestionRequest => ({
  id,
  sessionID,
  questions: [{ header: "Q", question: "Continue?", options: [] }],
  tool: { messageID: `msg_${id}`, callID: `call_${id}` },
})

const toolPart = (id: string, status: string) => ({
  id: `prt_${id}`,
  type: "tool",
  tool: "question",
  callID: `call_${id}`,
  state: { status },
}) as unknown as Part

const directoryState = (questions: QuestionRequest[], toolStatuses: Record<string, string>): State => ({
  ...INITIAL_STATE,
  question: Object.fromEntries(questions.map((entry) => [entry.sessionID, [entry as unknown as SdkQuestionRequest]])),
  part: Object.fromEntries(Object.entries(toolStatuses).map(([id, status]) => [`msg_${id}`, [toolPart(id, status)]])),
})

describe("computeOrphanedQuestionSignature", () => {
  test("judges each request in the directory store that holds it", () => {
    const primary = request("q1", "ses_primary")
    const worktreeChild = request("q2", "ses_worktree_child")
    const signature = computeOrphanedQuestionSignature([
      directoryState([primary], { q1: "running" }),
      directoryState([worktreeChild], { q2: "error" }),
    ], [primary, worktreeChild])

    expect(signature).toBe("ses_worktree_child\u0000q2")
  })

  test("is empty when nothing is orphaned or the request is not held anywhere", () => {
    const live = request("q1", "ses_a")
    expect(computeOrphanedQuestionSignature([directoryState([live], { q1: "running" })], [live])).toBe("")
    expect(computeOrphanedQuestionSignature([directoryState([], { q1: "error" })], [live])).toBe("")
    expect(computeOrphanedQuestionSignature([], [])).toBe("")
  })
})
