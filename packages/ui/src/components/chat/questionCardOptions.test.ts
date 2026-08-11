import { describe, expect, test } from "bun:test"

import { deriveCustomModeFromText, getQuestionOptionPresentation } from "./questionCardOptions"
import { isQuestionAnswerComplete } from "./questionCardNavigation"

describe("question card options", () => {
  test("removes a recommended marker from the displayed label", () => {
    expect(getQuestionOptionPresentation("Narrow fix (Recommended)")).toEqual({
      displayLabel: "Narrow fix",
      recommended: true,
    })
  })

  test("detects lowercase recommended markers", () => {
    expect(getQuestionOptionPresentation("Narrow fix (recommended)")).toEqual({
      displayLabel: "Narrow fix",
      recommended: true,
    })
  })

  test("keeps non-recommended labels unchanged", () => {
    expect(getQuestionOptionPresentation("Narrow fix")).toEqual({
      displayLabel: "Narrow fix",
      recommended: false,
    })
  })

  test("normalizes whitespace left after removing the recommended marker", () => {
    expect(getQuestionOptionPresentation("Narrow   fix   ( recommended )  now")).toEqual({
      displayLabel: "Narrow fix now",
      recommended: true,
    })
  })
})

describe("deriveCustomModeFromText", () => {
  test("empty and whitespace-only text keeps custom mode off", () => {
    expect(deriveCustomModeFromText("")).toBe(false)
    expect(deriveCustomModeFromText("   ")).toBe(false)
    expect(deriveCustomModeFromText("\n\t")).toBe(false)
  })

  test("typed text activates custom mode", () => {
    expect(deriveCustomModeFromText("do it differently")).toBe(true)
    expect(deriveCustomModeFromText(" x ")).toBe(true)
  })

  test("clearing the pill falls back to a selected option for answer completion", () => {
    const typed = "use approach B"
    expect(isQuestionAnswerComplete({
      isCustom: deriveCustomModeFromText(typed),
      customText: typed,
      selectedOptions: [],
    })).toBe(true)

    // Text cleared, option previously selected → the option answers.
    expect(isQuestionAnswerComplete({
      isCustom: deriveCustomModeFromText(""),
      customText: "",
      selectedOptions: ["Option A"],
    })).toBe(true)

    // Nothing typed, nothing selected → incomplete.
    expect(isQuestionAnswerComplete({
      isCustom: deriveCustomModeFromText(""),
      customText: "",
      selectedOptions: [],
    })).toBe(false)
  })
})
