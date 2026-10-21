import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

// Cross-component wiring that cannot be mounted cheaply (ChatInput and the
// global shortcut hook). The card's own behaviour lives in
// QuestionCard.interaction.test.tsx.
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")
const chatContainerSource = read("./ChatContainer.tsx")
const chatInputSource = read("./ChatInput.tsx")
const keyboardShortcutsSource = read("../../hooks/useKeyboardShortcuts.ts")

describe("QuestionCard placement", () => {
  test("renders inside the chat input composer, not the message viewport", () => {
    expect(chatInputSource).toContain("<QuestionCard")
    expect(chatInputSource).toContain("createScopedBlockingRequestsSelector")
    expect(chatContainerSource).not.toContain("key={sessionQuestions.map((q) => q.id).join('|')}")
    // The composer is hidden, not unmounted, during the takeover so draft
    // text, refs and drag-drop wiring survive a pending question.
    expect(chatInputSource).toContain("hasPendingQuestions && 'hidden'")
  })
})

describe("QuestionCard stopped-turn handling", () => {
  test("global Escape ignores a target inside the question card", () => {
    expect(keyboardShortcutsSource).toContain(`target?.closest('[data-question-card="true"]')`)
    expect(keyboardShortcutsSource).toContain("isInsideDialog || isInsideQuestionCard")
  })
})
