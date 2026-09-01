export type QuestionNavigationAnswer = {
  isCustom: boolean
  customText?: string
  selectedOptions?: readonly string[]
}

export type QuestionAnswerEnterInput = {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  isMobile: boolean
}

export function shouldHandleQuestionAnswerEnter(input: QuestionAnswerEnterInput): boolean {
  return input.key === "Enter"
    && !input.shiftKey
    && (!input.isMobile || input.ctrlKey || input.metaKey)
}

export function getPreviousQuestionIndex(currentIndex: number): number {
  return Math.max(0, currentIndex - 1)
}

export function getNextQuestionIndex(currentIndex: number, totalCount: number): number {
  if (totalCount <= 0) return 0
  return Math.min(totalCount - 1, currentIndex + 1)
}

export function getIndexAfterOptionSelection(input: {
  currentIndex: number
  totalCount: number
  multiple: boolean
}): number {
  if (input.multiple) return input.currentIndex
  return getNextQuestionIndex(input.currentIndex, input.totalCount)
}

export function isQuestionAnswerComplete(answer: QuestionNavigationAnswer): boolean {
  if (answer.isCustom) return Boolean(answer.customText?.trim())
  return (answer.selectedOptions?.length ?? 0) > 0
}
