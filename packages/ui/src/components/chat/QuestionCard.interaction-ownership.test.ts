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
const chatInputSource = readFileSync(
  fileURLToPath(new URL("./ChatInput.tsx", import.meta.url)),
  "utf8",
)
const optionRowSource = readFileSync(
  fileURLToPath(new URL("./QuestionOptionRow.tsx", import.meta.url)),
  "utf8",
)
const customEditorStart = source.indexOf("t('chat.questionCard.customPlaceholder')")
const customAnswerTextarea = source.slice(
  source.lastIndexOf("<textarea", customEditorStart),
  source.indexOf("/>", customEditorStart) + 2,
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

  test("uses an expanding multiline custom-answer editor with stable keyboard behavior", () => {
    expect(customAnswerTextarea).toContain("<textarea")
    expect(customAnswerTextarea).toContain("rows={1}")
    expect(customAnswerTextarea).toContain("field-sizing-content")
    expect(customAnswerTextarea).toContain("max-h-[min(40vh,18rem)]")
    expect(customAnswerTextarea).toContain("whitespace-pre-wrap")
    expect(customAnswerTextarea).toContain("onKeyDown={handleKeyDown}")
    expect(source).toContain("deriveCustomModeFromText")
    expect(source).toContain("shouldHandleQuestionAnswerEnter")
    // Focusing alone must not activate custom mode — only typed text does.
    expect(customAnswerTextarea).not.toContain("onFocus")
    // Actions stay out of the text row so they do not consume answer width.
    expect(source).toContain("border-t border-border/30")
  })

  test("collapses submitted requests optimistically instead of showing a blocking spinner", () => {
    // The card must acknowledge (hide) submitted requests BEFORE awaiting the
    // network round trip — the spinner block that blocked the card for the
    // whole POST is deliberately gone.
    expect(source).not.toContain("data-question-submission-state")
    expect(source).not.toContain("chat.questionCard.submittingAnswer")
    expect(source).not.toContain("chat.questionCard.skippingQuestion")
    expect(source).toContain("chat.questionCard.sendingResponse")
    expect(source).toContain('className="flex min-h-[54px] items-center')
    expect(source).toContain('role="status"')
    expect(source).toContain('aria-live="polite"')

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

    // While the authoritative request is still present, the optimistic state
    // must retain a real surface instead of reducing the composer to its border.
    const emptyStateIndex = source.indexOf("if (totalCount === 0)")
    const compactStateIndex = source.indexOf("chat.questionCard.sendingResponse")
    expect(emptyStateIndex).toBeGreaterThan(-1)
    expect(compactStateIndex).toBeGreaterThan(emptyStateIndex)
  })

  test("renders inside the chat input composer, not the message viewport", () => {
    expect(chatInputSource).toContain("<QuestionCard")
    expect(chatInputSource).toContain("createScopedBlockingRequestsSelector")
    expect(chatContainerSource).not.toContain("<QuestionCard")
    expect(chatContainerSource).not.toContain("key={sessionQuestions.map((q) => q.id).join('|')}")
    // The composer is hidden, not unmounted, during the takeover so draft
    // text, refs and drag-drop wiring survive a pending question.
    expect(chatInputSource).toContain("hasPendingQuestions && 'hidden'")
  })

  test("keeps narrow option labels readable with unnumbered badges and a muted recommended pill", () => {
    expect(optionRowSource).toContain("flex flex-wrap items-baseline")
    // Constant weight — selection must not change label width (card height shifts).
    expect(optionRowSource).toContain("typography-meta font-medium break-words")
    // Badges are deliberately empty circles — no option numbers.
    expect(optionRowSource).not.toContain("index")
    expect(optionRowSource).toContain("rounded-full bg-muted/60")
    expect(optionRowSource).not.toContain("break-all")
    expect(optionRowSource).not.toContain("text-primary/80")
  })
})
