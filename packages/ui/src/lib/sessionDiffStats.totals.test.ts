import { describe, expect, test } from 'bun:test'

import {
  getScopedMessageDiffTotals,
  getSessionSummaryDiffTotals,
  parseSessionDiffCount,
  resolveSessionDiffStats,
  type SessionSummaryDiffEntry,
  type SessionSummaryDiffStats,
} from './sessionDiffStats'

describe('parseSessionDiffCount', () => {
  test('keeps finite non-negative numbers, fractions and very large values included', () => {
    expect(parseSessionDiffCount(0)).toBe(0)
    expect(parseSessionDiffCount(7)).toBe(7)
    expect(parseSessionDiffCount(2.5)).toBe(2.5)
    expect(parseSessionDiffCount(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER)
    expect(parseSessionDiffCount(Number.MAX_VALUE)).toBe(Number.MAX_VALUE)
  })

  test('clamps negative numbers to zero and turns negative zero into zero', () => {
    expect(parseSessionDiffCount(-1)).toBe(0)
    expect(parseSessionDiffCount(-0.5)).toBe(0)
    expect(parseSessionDiffCount(-Number.MAX_VALUE)).toBe(0)
    expect(parseSessionDiffCount(-0)).toBe(0)
  })

  test('maps non-finite numbers, null and undefined to zero', () => {
    expect(parseSessionDiffCount(Number.NaN)).toBe(0)
    expect(parseSessionDiffCount(Number.POSITIVE_INFINITY)).toBe(0)
    expect(parseSessionDiffCount(Number.NEGATIVE_INFINITY)).toBe(0)
    expect(parseSessionDiffCount(null)).toBe(0)
    expect(parseSessionDiffCount(undefined)).toBe(0)
  })

  test('parses strings with Number semantics', () => {
    expect(parseSessionDiffCount('12')).toBe(12)
    expect(parseSessionDiffCount(' 12 ')).toBe(12)
    expect(parseSessionDiffCount('\u00a012\n')).toBe(12)
    expect(parseSessionDiffCount('1.5')).toBe(1.5)
    expect(parseSessionDiffCount('1e3')).toBe(1000)
    expect(parseSessionDiffCount('0x10')).toBe(16)
    expect(parseSessionDiffCount('0b11')).toBe(3)
    expect(parseSessionDiffCount('+4')).toBe(4)
  })

  test('an empty or blank string parses as zero', () => {
    expect(parseSessionDiffCount('')).toBe(0)
    expect(parseSessionDiffCount('   ')).toBe(0)
  })

  test('negative, non-numeric and non-finite strings give zero', () => {
    expect(parseSessionDiffCount('-4')).toBe(0)
    expect(parseSessionDiffCount('abc')).toBe(0)
    expect(parseSessionDiffCount('5px')).toBe(0)
    expect(parseSessionDiffCount('1,000')).toBe(0)
    expect(parseSessionDiffCount('Infinity')).toBe(0)
    expect(parseSessionDiffCount('NaN')).toBe(0)
    expect(parseSessionDiffCount('\u0661\u0662')).toBe(0)
    expect(parseSessionDiffCount('\ud800')).toBe(0)
    expect(parseSessionDiffCount('1'.repeat(400))).toBe(0)
  })
})

describe('getSessionSummaryDiffTotals', () => {
  test('returns zero totals without a summary, as a new object each time', () => {
    expect(getSessionSummaryDiffTotals()).toEqual({ additions: 0, deletions: 0 })
    expect(getSessionSummaryDiffTotals(null)).toEqual({ additions: 0, deletions: 0 })
    expect(getSessionSummaryDiffTotals(undefined)).not.toBe(getSessionSummaryDiffTotals(undefined))
  })

  test('uses the top-level totals and ignores the entries when either total is present', () => {
    expect(getSessionSummaryDiffTotals({
      additions: 4,
      deletions: '2',
      diffs: [{ file: 'a', additions: 100, deletions: 100 }],
    })).toEqual({ additions: 4, deletions: 2 })

    expect(getSessionSummaryDiffTotals({
      deletions: 3,
      diffs: [{ file: 'a', additions: 100 }],
    })).toEqual({ additions: 0, deletions: 3 })
  })

  test('a null top-level total counts as present and hides the entries', () => {
    expect(getSessionSummaryDiffTotals({
      additions: null,
      diffs: [{ file: 'a', additions: 5, deletions: 6 }],
    })).toEqual({ additions: 0, deletions: 0 })
  })

  test('sums the entries when neither top-level total is present', () => {
    expect(getSessionSummaryDiffTotals({
      files: 3,
      diffs: [
        { file: 'a', additions: 1, deletions: 2 },
        { file: 'b', additions: '3', deletions: null },
        { file: 'c', additions: -10, deletions: Number.NaN },
        { file: 'a', additions: 1, deletions: 2 },
      ],
    })).toEqual({ additions: 5, deletions: 4 })
  })

  test('throws on a null entry when it has to sum the entries', () => {
    const diffs = [null] as unknown as SessionSummaryDiffEntry[]
    let caught: unknown
    try {
      getSessionSummaryDiffTotals({ diffs })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(TypeError)
    // With a top-level total present the entries are not read.
    expect(getSessionSummaryDiffTotals({ additions: 1, diffs })).toEqual({ additions: 1, deletions: 0 })
  })

  test('sums deletions across several entries', () => {
    expect(getSessionSummaryDiffTotals({
      diffs: [{ deletions: 2 }, { deletions: 3 }, { deletions: '4' }],
    })).toEqual({ additions: 0, deletions: 9 })
  })

  test('treats a missing or null entry list as no entries', () => {
    expect(getSessionSummaryDiffTotals({})).toEqual({ additions: 0, deletions: 0 })
    expect(getSessionSummaryDiffTotals({ diffs: null })).toEqual({ additions: 0, deletions: 0 })
    expect(getSessionSummaryDiffTotals({ diffs: [] })).toEqual({ additions: 0, deletions: 0 })
  })
})

describe('getScopedMessageDiffTotals', () => {
  test('ignores top-level totals and sums only the entries', () => {
    expect(getScopedMessageDiffTotals({
      additions: 95,
      deletions: 3,
      diffs: [
        { file: 'a', additions: 2, deletions: 1 },
        { file: 'b', additions: '4', deletions: '0' },
      ],
    })).toEqual({ additions: 6, deletions: 1 })
    expect(getScopedMessageDiffTotals({ additions: 95, deletions: 3 })).toEqual({ additions: 0, deletions: 0 })
  })

  test('returns zero totals without a summary or entries', () => {
    expect(getScopedMessageDiffTotals()).toEqual({ additions: 0, deletions: 0 })
    expect(getScopedMessageDiffTotals(null)).toEqual({ additions: 0, deletions: 0 })
    expect(getScopedMessageDiffTotals({ diffs: null })).toEqual({ additions: 0, deletions: 0 })
  })

  test('sums additions and deletions across several positive entries', () => {
    expect(getScopedMessageDiffTotals({
      diffs: [
        { additions: 1, deletions: 4 },
        { additions: 2, deletions: '3' },
        { additions: 0, deletions: 5 },
      ],
    })).toEqual({ additions: 3, deletions: 12 })
  })

  test('clamps each entry before summing, so a negative entry does not cancel a positive one', () => {
    expect(getScopedMessageDiffTotals({
      diffs: [
        { additions: 3, deletions: -5 },
        { additions: -5, deletions: 2 },
      ],
    })).toEqual({ additions: 3, deletions: 2 })
  })

  test('sums fractions with floating-point arithmetic and overflows to infinity', () => {
    expect(getScopedMessageDiffTotals({
      diffs: [{ additions: 0.1 }, { additions: 0.2 }],
    }).additions).toBe(0.30000000000000004)
    expect(getScopedMessageDiffTotals({
      diffs: [{ additions: Number.MAX_VALUE }, { additions: Number.MAX_VALUE }],
    }).additions).toBe(Number.POSITIVE_INFINITY)
  })

  test('throws on a null entry', () => {
    const diffs = [null] as unknown as SessionSummaryDiffEntry[]
    let caught: unknown
    try {
      getScopedMessageDiffTotals({ diffs })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(TypeError)
  })

  test('does not mutate the summary', () => {
    const summary: SessionSummaryDiffStats = { additions: 1, diffs: [{ file: 'a', additions: '2' }] }
    getScopedMessageDiffTotals(summary)
    expect(summary).toEqual({ additions: 1, diffs: [{ file: 'a', additions: '2' }] })
  })
})

describe('resolveSessionDiffStats', () => {
  test('returns null when the scoped entries sum to zero', () => {
    expect(resolveSessionDiffStats()).toBeNull()
    expect(resolveSessionDiffStats(null)).toBeNull()
    expect(resolveSessionDiffStats({ additions: 40, deletions: 2 })).toBeNull()
    expect(resolveSessionDiffStats({ diffs: [{ additions: 0, deletions: '0' }, { additions: -3 }] })).toBeNull()
  })

  test('returns the scoped totals when either is non-zero', () => {
    expect(resolveSessionDiffStats({ diffs: [{ additions: 0, deletions: 1 }] })).toEqual({ additions: 0, deletions: 1 })
    expect(resolveSessionDiffStats({ diffs: [{ additions: '2' }] })).toEqual({ additions: 2, deletions: 0 })
    expect(resolveSessionDiffStats({
      additions: 99,
      diffs: [{ additions: 1, deletions: 1 }],
    })).toEqual({ additions: 1, deletions: 1 })
  })

  test('returns a fraction that is above zero', () => {
    expect(resolveSessionDiffStats({ diffs: [{ additions: Number.MIN_VALUE }] })).toEqual({
      additions: Number.MIN_VALUE,
      deletions: 0,
    })
  })
})
