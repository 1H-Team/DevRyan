import { describe, expect, test } from "bun:test"
import type { QuestionRequest } from "@/types/question"
import type { SendConfig } from "@/sync/send-config"
import type { QuestionRequestAnswerGroup } from "./questionCardRouting"
import {
  submitQuestionAnswersWithOrphanResume,
  type OrphanResumeDelivery,
  type QuestionAnswerSubmissionDependencies,
} from "./questionOrphanResume"

const question = (id: string, sessionID: string, text = `Question ${id}?`): QuestionRequest => ({
  id,
  sessionID,
  questions: [{ header: "Q", question: text, options: [] }],
  tool: { messageID: `msg_${id}`, callID: `call_${id}` },
})

const group = (request: QuestionRequest, answer: string): QuestionRequestAnswerGroup => ({
  request,
  answers: [[answer]],
})

class OrphanedError extends Error {}

const ROOT_OF: Record<string, string> = { ses_child: "ses_root", ses_child2: "ses_root", ses_root: "ses_root", ses_other: "ses_other" }

const createDeps = (overrides: {
  respondToQuestion?: QuestionAnswerSubmissionDependencies["respondToQuestion"]
  resolveSendConfig?: () => SendConfig
  authorizeSend?: QuestionAnswerSubmissionDependencies["authorizeSend"]
  sendMessage?: QuestionAnswerSubmissionDependencies["sendMessage"]
} = {}) => {
  const calls: string[] = []
  const sent: OrphanResumeDelivery[] = []
  const queued: OrphanResumeDelivery[] = []
  const preserved: OrphanResumeDelivery[] = []
  const deps: QuestionAnswerSubmissionDependencies = {
    respondToQuestion: overrides.respondToQuestion ?? (async (_sessionID, requestID) => {
      calls.push(`reply:${requestID}`)
    }),
    isOrphanedError: (error) => error instanceof OrphanedError,
    resolveRootSessionId: (sessionId) => ROOT_OF[sessionId] ?? sessionId,
    resolveSendConfig: overrides.resolveSendConfig
      ?? (() => ({ providerID: "openai", modelID: "gpt", agent: "orchestrator", variant: null, planMode: false })),
    authorizeSend: overrides.authorizeSend ?? (async () => true),
    discardQuestion: async (_sessionID, requestID) => {
      calls.push(`discard:${requestID}`)
    },
    sendMessage: overrides.sendMessage ?? (async (delivery) => {
      calls.push(`send:${delivery.sessionId}`)
      sent.push(delivery)
    }),
    queueMessage: (delivery) => {
      calls.push(`queue:${delivery.sessionId}`)
      queued.push(delivery)
    },
    preserveUnsentAnswer: (delivery) => {
      calls.push(`preserve:${delivery.sessionId}`)
      preserved.push(delivery)
    },
  }
  return { deps, calls, sent, queued, preserved }
}

const statuses = (results: Awaited<ReturnType<typeof submitQuestionAnswersWithOrphanResume>>) => (
  results.map((result) => `${result.request.id}:${result.status}`)
)

describe("submitQuestionAnswersWithOrphanResume", () => {
  test("replies normally when every turn is alive", async () => {
    const { deps, calls } = createDeps()
    const results = await submitQuestionAnswersWithOrphanResume([group(question("q1", "ses_child"), "A")], () => false, deps)
    expect(calls).toEqual(["reply:q1"])
    expect(statuses(results)).toEqual(["q1:fulfilled"])
  })

  test("a known orphan's dead request is discarded, then its answer goes to the conversation root", async () => {
    const { deps, calls, sent } = createDeps()
    const orphan = question("q1", "ses_child")
    const results = await submitQuestionAnswersWithOrphanResume([group(orphan, "Blue")], () => true, deps)

    expect(calls).toEqual(["discard:q1", "send:ses_root"])
    expect(sent[0].content).toContain("Answer: Blue")
    expect(sent[0].config.agent).toBe("orchestrator")
    expect(statuses(results)).toEqual(["q1:fulfilled"])
  })

  test("live replies settle before any orphan delivery, which queues behind the resumed turn", async () => {
    const { deps, calls, queued, sent } = createDeps()
    const live = question("q-live", "ses_child")
    const orphan = question("q-dead", "ses_child2")
    const results = await submitQuestionAnswersWithOrphanResume(
      [group(orphan, "Red"), group(live, "Yes")],
      (request) => request.id === "q-dead",
      deps,
    )

    // The live reply lands before the orphan's dead request is touched, and the
    // answer waits for the resumed root turn instead of racing it.
    expect(calls).toEqual(["reply:q-live", "discard:q-dead", "queue:ses_root"])
    expect(sent).toEqual([])
    expect(queued[0].content).toContain("Answer: Red")
    expect(statuses(results)).toEqual(["q-dead:fulfilled", "q-live:fulfilled"])
  })

  test("several orphans in one root become a single message", async () => {
    const { deps, calls, sent } = createDeps()
    const results = await submitQuestionAnswersWithOrphanResume(
      [group(question("q1", "ses_child", "Color?"), "Red"), group(question("q2", "ses_child2", "Size?"), "Large")],
      () => true,
      deps,
    )

    expect(calls).toEqual(["discard:q1", "discard:q2", "send:ses_root"])
    expect(sent).toHaveLength(1)
    expect(sent[0].content).toContain("- Color?\n  Answer: Red")
    expect(sent[0].content).toContain("- Size?\n  Answer: Large")
    expect(statuses(results)).toEqual(["q1:fulfilled", "q2:fulfilled"])
  })

  test("a reply the server reports orphaned is resent as a message", async () => {
    const { deps, calls } = createDeps({
      respondToQuestion: async () => { throw new OrphanedError("stopped") },
    })
    const results = await submitQuestionAnswersWithOrphanResume([group(question("q1", "ses_child"), "A")], () => false, deps)
    expect(calls).toEqual(["discard:q1", "send:ses_root"])
    expect(statuses(results)).toEqual(["q1:fulfilled"])
  })

  test("other reply failures propagate without sending anything", async () => {
    const { deps, calls } = createDeps({
      respondToQuestion: async () => { throw new Error("network down") },
    })
    const results = await submitQuestionAnswersWithOrphanResume([group(question("q1", "ses_child"), "A")], () => false, deps)
    expect(calls).toEqual([])
    expect(statuses(results)).toEqual(["q1:rejected"])
  })

  test("a failed send preserves the combined answer and reports every request in the group as failed", async () => {
    const { deps, calls, preserved } = createDeps({
      sendMessage: async () => { throw new Error("send failed") },
    })
    const results = await submitQuestionAnswersWithOrphanResume(
      [group(question("q1", "ses_child"), "Blue"), group(question("q2", "ses_child2"), "Small")],
      () => true,
      deps,
    )
    expect(calls).toEqual(["discard:q1", "discard:q2", "preserve:ses_root"])
    expect(preserved[0].content).toContain("Answer: Blue")
    expect(preserved[0].content).toContain("Answer: Small")
    expect(statuses(results)).toEqual(["q1:rejected", "q2:rejected"])
  })

  test("refuses to send without a model or without handoff authorization, keeping the dead request", async () => {
    const noModel = createDeps({ resolveSendConfig: () => ({ agent: "orchestrator" }) })
    const first = await submitQuestionAnswersWithOrphanResume([group(question("q1", "ses_child"), "A")], () => true, noModel.deps)
    expect(noModel.calls).toEqual([])
    expect(statuses(first)).toEqual(["q1:rejected"])

    const denied = createDeps({ authorizeSend: async () => false })
    const second = await submitQuestionAnswersWithOrphanResume([group(question("q1", "ses_child"), "A")], () => true, denied.deps)
    expect(denied.calls).toEqual([])
    expect(statuses(second)).toEqual(["q1:rejected"])
  })

  test("orphans from different roots are delivered separately", async () => {
    const { deps, calls } = createDeps()
    await submitQuestionAnswersWithOrphanResume(
      [group(question("q1", "ses_child"), "A"), group(question("q2", "ses_other"), "B")],
      () => true,
      deps,
    )
    expect(calls).toEqual(["discard:q1", "send:ses_root", "discard:q2", "send:ses_other"])
  })
})
