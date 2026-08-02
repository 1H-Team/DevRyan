import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const source = readFileSync(
  fileURLToPath(new URL("./QuestionCard.tsx", import.meta.url)),
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
})
