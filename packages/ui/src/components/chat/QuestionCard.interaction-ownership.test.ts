import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const source = readFileSync(
  fileURLToPath(new URL("./QuestionCard.tsx", import.meta.url)),
  "utf8",
)
const chatContainerSource = readFileSync(
  fileURLToPath(new URL("./ChatContainer.tsx", import.meta.url)),
  "utf8",
)
const optionRowSource = readFileSync(
  fileURLToPath(new URL("./QuestionOptionRow.tsx", import.meta.url)),
  "utf8",
)
const customAnswerTextareaStart = source.indexOf("<textarea")
const customAnswerTextarea = source.slice(
  customAnswerTextareaStart,
  source.indexOf("/>", customAnswerTextareaStart) + 2,
)

describe("QuestionCard option interaction ownership", () => {
  test("delegates option rows without nested interactive checkbox or radio controls", () => {
    expect(source).toContain("<QuestionOptionRow")
    expect(source).not.toContain("<Checkbox")
    expect(source).not.toContain("<Radio")
    expect(source).not.toContain("@/components/ui/checkbox")
    expect(source).not.toContain("@/components/ui/radio")
  })

  test("labels rejection as Skip and keeps it independent from answer completion", () => {
    expect(source).toContain("const handleSkip")
    expect(source).toContain("t('chat.questionCard.skip')")
    expect(source).toContain("onClick={handleSkip}")
    expect(source).not.toContain("handleDismiss")
    expect(source).not.toContain("chat.questionCard.dismiss")
  })

  test("keeps long custom answers vertically scrollable inside the chat", () => {
    expect(customAnswerTextarea).toContain("<textarea")
    expect(customAnswerTextarea).toContain("data-scrollable")
    expect(customAnswerTextarea).toContain("overflow-y-auto")
    expect(customAnswerTextarea).toContain("overflow-x-hidden")
    expect(customAnswerTextarea).not.toContain("overflow-hidden")
  })

  test("collapses submitted requests optimistically instead of showing a blocking spinner", () => {
    // The card must acknowledge (hide) submitted requests BEFORE awaiting the
    // network round trip — the spinner block that blocked the card for the
    // whole POST is deliberately gone.
    expect(source).not.toContain("data-question-submission-state")
    expect(source).not.toContain("chat.questionCard.submittingAnswer")
    expect(source).not.toContain("chat.questionCard.skippingQuestion")

    const optimisticAckIndex = source.indexOf("acknowledgeQuestionRequests(previous, answerGroups")
    const awaitSubmitIndex = source.indexOf("await submitQuestionRequestAnswerGroups")
    expect(optimisticAckIndex).toBeGreaterThan(-1)
    expect(awaitSubmitIndex).toBeGreaterThan(-1)
    expect(optimisticAckIndex).toBeLessThan(awaitSubmitIndex)

    const optimisticSkipAckIndex = source.indexOf("acknowledgeQuestionRequests(previous, targetRequests)")
    const awaitSkipIndex = source.indexOf("await submitQuestionRequestRejections")
    expect(optimisticSkipAckIndex).toBeGreaterThan(-1)
    expect(awaitSkipIndex).toBeGreaterThan(-1)
    expect(optimisticSkipAckIndex).toBeLessThan(awaitSkipIndex)

    // Failures after unmount/scope change must surface via toast, not vanish.
    expect(source).toContain("from '@/components/ui/toast'")
    expect(source).toContain("chat.questionCard.submitFailedToast")
  })

  test("preserves card ownership when a sibling request is acknowledged", () => {
    expect(chatContainerSource).toContain("<QuestionCard")
    expect(chatContainerSource).not.toContain("key={sessionQuestions.map((q) => q.id).join('|')}")
  })

  test("keeps narrow option labels readable and recommended text at full contrast", () => {
    expect(optionRowSource).toContain("flex flex-wrap items-baseline")
    expect(optionRowSource).toContain("typography-meta break-words")
    expect(optionRowSource).toContain('className="typography-micro text-primary"')
    expect(optionRowSource).not.toContain("break-all")
    expect(optionRowSource).not.toContain("text-primary/80")
  })
})
