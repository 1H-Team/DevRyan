import { describe, expect, test } from "bun:test"

import {
  getIndexAfterOptionSelection,
  getNextQuestionIndex,
  getPreviousQuestionIndex,
  isQuestionAnswerComplete,
  shouldHandleQuestionAnswerEnter,
} from "./questionCardNavigation"

describe("question card navigation", () => {
  test("single-choice option selection advances unless it is the final question", () => {
    expect(getIndexAfterOptionSelection({ currentIndex: 0, totalCount: 3, multiple: false })).toBe(1)
    expect(getIndexAfterOptionSelection({ currentIndex: 2, totalCount: 3, multiple: false })).toBe(2)
  })

  test("multi-select option selection does not advance automatically", () => {
    expect(getIndexAfterOptionSelection({ currentIndex: 0, totalCount: 3, multiple: true })).toBe(0)
  })

  test("custom answers require non-empty trimmed text", () => {
    expect(isQuestionAnswerComplete({ isCustom: true, customText: "  " })).toBe(false)
    expect(isQuestionAnswerComplete({ isCustom: true, customText: "  Use project Alpha  " })).toBe(true)
  })

  test("selected option answers are complete when at least one option is selected", () => {
    expect(isQuestionAnswerComplete({ isCustom: false, selectedOptions: [] })).toBe(false)
    expect(isQuestionAnswerComplete({ isCustom: false, selectedOptions: ["High"] })).toBe(true)
  })

  test("back and next indexes stay within question bounds", () => {
    expect(getPreviousQuestionIndex(0)).toBe(0)
    expect(getPreviousQuestionIndex(2)).toBe(1)
    expect(getNextQuestionIndex(0, 3)).toBe(1)
    expect(getNextQuestionIndex(2, 3)).toBe(2)
    expect(getNextQuestionIndex(0, 0)).toBe(0)
  })

  test("desktop Enter submits while Shift+Enter remains available for a newline", () => {
    expect(shouldHandleQuestionAnswerEnter({
      key: "Enter",
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      isMobile: false,
    })).toBe(true)
    expect(shouldHandleQuestionAnswerEnter({
      key: "Enter",
      shiftKey: true,
      ctrlKey: false,
      metaKey: false,
      isMobile: false,
    })).toBe(false)
  })

  test("mobile Enter inserts a newline unless Command or Control is held", () => {
    expect(shouldHandleQuestionAnswerEnter({
      key: "Enter",
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      isMobile: true,
    })).toBe(false)
    expect(shouldHandleQuestionAnswerEnter({
      key: "Enter",
      shiftKey: false,
      ctrlKey: true,
      metaKey: false,
      isMobile: true,
    })).toBe(true)
    expect(shouldHandleQuestionAnswerEnter({
      key: "Enter",
      shiftKey: false,
      ctrlKey: false,
      metaKey: true,
      isMobile: true,
    })).toBe(true)
  })

  test("non-Enter keys stay in the multiline editor", () => {
    expect(shouldHandleQuestionAnswerEnter({
      key: "a",
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      isMobile: false,
    })).toBe(false)
  })
})
