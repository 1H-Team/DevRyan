import { describe, expect, test } from "bun:test"
import type { OpencodeClient, QuestionRequest } from "@opencode-ai/sdk/v2/client"

import { syncQuestionSnapshot } from "./bootstrap"
import { INITIAL_STATE, type State } from "./types"

const buildQuestion = (id: string, sessionID = "ses_a"): QuestionRequest => ({
  id,
  sessionID,
  questions: [{
    header: "Choice",
    question: id,
    options: [{ label: "A", description: "First" }, { label: "B", description: "Second" }],
  }],
})

const createState = (questions: QuestionRequest[]): State => ({
  ...INITIAL_STATE,
  question: questions.reduce<Record<string, QuestionRequest[]>>((grouped, question) => {
    grouped[question.sessionID] = [...(grouped[question.sessionID] ?? []), question]
    return grouped
  }, {}),
})

describe("question bootstrap snapshots", () => {
  test("retains existing source records and merges Cursor records for a partial OpenCode response", async () => {
    const existing = buildQuestion("req_open")
    const cursor = buildQuestion("req_cursor")
    let state = createState([existing])
    const sdk = {
      question: {
        list: () => Promise.resolve({
          data: [cursor],
          response: new Response(null, { headers: { "X-DevRyan-Question-Partial": "opencode" } }),
        }),
      },
    } as unknown as OpencodeClient

    let retryError: unknown
    try {
      await syncQuestionSnapshot({
        directory: "/repo",
        sdk,
        getState: () => state,
        set: (patch) => { state = { ...state, ...patch } },
      })
    } catch (error) {
      retryError = error
    }
    const retryStatus = retryError && typeof retryError === "object" && "status" in retryError
      ? retryError.status
      : undefined
    expect(retryStatus).toBe(503)

    expect(state.question.ses_a?.map((question) => question.id)).toEqual(["req_cursor", "req_open"])
  })

  test("reconciles and removes absent records after a complete merged response", async () => {
    const stale = buildQuestion("req_stale")
    const current = buildQuestion("req_current")
    let state = createState([stale])
    const sdk = {
      question: {
        list: () => Promise.resolve({
          data: [current],
          response: new Response(null),
        }),
      },
    } as unknown as OpencodeClient

    await syncQuestionSnapshot({
      directory: "/repo",
      sdk,
      getState: () => state,
      set: (patch) => { state = { ...state, ...patch } },
    })

    expect(state.question.ses_a?.map((question) => question.id)).toEqual(["req_current"])
  })
})
