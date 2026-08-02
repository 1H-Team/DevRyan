import { describe, expect, test } from 'bun:test'

import {
  consumeMobileSyntheticClick,
  stepNumberInputValue,
  type NumberInputDirection,
} from './number-input-value'

const runStepsBeforeParentRender = ({
  parentValue,
  direction,
  count,
  min = -Infinity,
  max = Infinity,
  step = 1,
}: {
  parentValue: number
  direction: NumberInputDirection
  count: number
  min?: number
  max?: number
  step?: number
}) => {
  let optimisticValue = parentValue
  const committed: number[] = []

  for (let index = 0; index < count; index += 1) {
    optimisticValue = stepNumberInputValue({
      optimisticValue,
      fallbackValue: undefined,
      min,
      max,
      step,
      direction,
    })
    committed.push(optimisticValue)
  }

  return { parentValue, optimisticValue, committed }
}

describe('number input step values', () => {
  test('applies multiple rapid increments before a parent rerender', () => {
    expect(runStepsBeforeParentRender({ parentValue: 1, direction: 1, count: 3 })).toEqual({
      parentValue: 1,
      optimisticValue: 4,
      committed: [2, 3, 4],
    })
  })

  test('applies multiple rapid decrements before a parent rerender', () => {
    expect(runStepsBeforeParentRender({ parentValue: 4, direction: -1, count: 3 })).toEqual({
      parentValue: 4,
      optimisticValue: 1,
      committed: [3, 2, 1],
    })
  })

  test('normalizes decimal steps without floating-point drift', () => {
    expect(runStepsBeforeParentRender({ parentValue: 0.1, direction: 1, count: 3, step: 0.1 }).committed)
      .toEqual([0.2, 0.3, 0.4])
  })

  test('clamps rapid decrements to the minimum', () => {
    expect(runStepsBeforeParentRender({ parentValue: 1, direction: -1, count: 3, min: 0 }).committed)
      .toEqual([0, 0, 0])
  })

  test('clamps rapid increments to the maximum', () => {
    expect(runStepsBeforeParentRender({ parentValue: 1, direction: 1, count: 3, max: 2 }).committed)
      .toEqual([2, 2, 2])
  })

  test('consumes the synthetic click following a mobile touch only once', () => {
    const guard = { current: false }
    let increments = 0

    guard.current = true
    increments += 1
    if (consumeMobileSyntheticClick(guard)) increments += 1

    expect(increments).toBe(1)
    expect(consumeMobileSyntheticClick(guard)).toBe(true)
  })
})
