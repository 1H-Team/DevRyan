import { describe, expect, test } from 'bun:test'

import {
  getSessionTouchedFilePaths,
  getChatOwnedDiffTotalsFromMessages,
  normalizeChatOwnedDiffSummary,
  resolveSessionWorkingTreeDiffStats,
  resolveSessionDiffStats,
  stripUntrustedSessionDiffSummary,
} from './sessionDiffStats'

describe('sessionDiffStats', () => {
  test('uses current working-tree totals for files touched by the active session', () => {
    const messages = [
      {
        role: 'user',
        summary: {
          diffs: [{ file: 'diff-counter-visual-check.txt', additions: 3, deletions: 0 }],
        },
      },
      {
        role: 'user',
        summary: {
          diffs: [{ file: 'diff-counter-visual-check.txt', additions: 1, deletions: 1 }],
        },
      },
      {
        role: 'assistant',
        summary: {
          diffs: [{ file: 'unrelated.txt', additions: 50, deletions: 10 }],
        },
      },
    ]

    expect(getSessionTouchedFilePaths(messages)).toEqual(['diff-counter-visual-check.txt'])
    expect(resolveSessionWorkingTreeDiffStats(messages, {
      'diff-counter-visual-check.txt': { insertions: 3, deletions: 0 },
      'unrelated.txt': { insertions: 50, deletions: 10 },
    })).toEqual({ additions: 3, deletions: 0 })
  })

  test('hides active-session totals once its touched files are clean', () => {
    const messages = [{
      role: 'user',
      summary: {
        diffs: [{ file: './diff-counter-visual-check.txt', additions: 3, deletions: 0 }],
      },
    }]

    expect(getSessionTouchedFilePaths(messages)).toEqual(['diff-counter-visual-check.txt'])
    expect(resolveSessionWorkingTreeDiffStats(messages, {})).toBeNull()
    expect(resolveSessionWorkingTreeDiffStats(messages, undefined)).toBeNull()
  })

  test('derives chat-owned totals from user message summaries only', () => {
    expect(getChatOwnedDiffTotalsFromMessages([
      { role: 'assistant', summary: { additions: 100, deletions: 50 } },
      { role: 'user', summary: { diffs: [{ additions: 2, deletions: 1 }, { additions: '3', deletions: '4' }] } },
      { role: 'user', summary: { additions: 5, deletions: 0 } },
    ])).toEqual({ additions: 5, deletions: 5 })
  })

  test('ignores bare user summary totals that are not scoped to diff entries', () => {
    const session = { id: 'ses_1', summary: undefined }

    expect(normalizeChatOwnedDiffSummary(session, [
      { role: 'user', summary: { additions: 1, deletions: 15465 } },
    ])).toEqual({ id: 'ses_1' })
  })

  test('keeps valid scoped diff entries from user message summaries', () => {
    expect(getChatOwnedDiffTotalsFromMessages([
      { role: 'user', summary: { diffs: [{ additions: 1, deletions: 0 }, { additions: 2, deletions: 3 }] } },
    ])).toEqual({ additions: 3, deletions: 3 })
  })

  test('sidebar stats ignore bare session-level totals', () => {
    expect(resolveSessionDiffStats({ additions: 118, deletions: 22864 })).toBeNull()
  })

  test('sidebar stats trust scoped summary diff entries', () => {
    expect(resolveSessionDiffStats({
      additions: 999,
      deletions: 999,
      diffs: [{ additions: 2, deletions: 1 }, { additions: '3', deletions: '4' }],
    })).toEqual({ additions: 5, deletions: 5 })
  })

  test('removes stale session-level diff fields when chat messages have no scoped diffs', () => {
    const session = {
      id: 'ses_1',
      summary: {
        title: 'Preserved title',
        additions: 95,
        deletions: 3,
        files: 2,
        diffs: [{ additions: 95, deletions: 3 }],
      },
    }

    expect(normalizeChatOwnedDiffSummary(session, [{ role: 'user' }])).toEqual({
      id: 'ses_1',
      summary: { title: 'Preserved title' },
    })
  })

  test('strips untrusted session-level diff fields while preserving summary metadata', () => {
    const session = {
      id: 'ses_1',
      summary: {
        title: 'Preserved title',
        additions: 95,
        deletions: 3,
        files: 2,
        diffs: [{ additions: 95, deletions: 3 }],
      },
    }

    expect(stripUntrustedSessionDiffSummary(session)).toEqual({
      id: 'ses_1',
      summary: { title: 'Preserved title' },
    })
  })

  test('strips untrusted session-list snapshot totals even when no metadata remains', () => {
    const session = {
      id: 'ses_1',
      summary: {
        additions: 95,
        deletions: 3,
        files: 2,
        diffs: [{ additions: 95, deletions: 3 }],
      },
    }

    expect(stripUntrustedSessionDiffSummary(session)).toEqual({ id: 'ses_1' })
  })

  test('preserves object identity when chat-owned totals are already normalized', () => {
    const session = {
      id: 'ses_1',
      summary: { title: 'Preserved title', diffs: [{ additions: 2, deletions: 1 }] },
    }

    expect(normalizeChatOwnedDiffSummary(session, [
      { role: 'user', summary: { diffs: [{ additions: 2, deletions: 1 }] } },
    ])).toBe(session)
  })

  test('normalizes chat-owned totals as trusted scoped diff entries', () => {
    const session = {
      id: 'ses_1',
      summary: { title: 'Preserved title', additions: 95, deletions: 3 },
    }

    expect(normalizeChatOwnedDiffSummary(session, [
      { role: 'user', summary: { diffs: [{ additions: 2, deletions: 1 }] } },
    ])).toEqual({
      id: 'ses_1',
      summary: { title: 'Preserved title', diffs: [{ additions: 2, deletions: 1 }] },
    })
  })
})
