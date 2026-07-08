import { describe, expect, test } from "bun:test"

import { getQuestionOptionPresentation } from "./questionCardOptions"

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
