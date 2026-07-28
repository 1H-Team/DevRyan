import { describe, expect, test } from 'bun:test'

import {
  normalizeChatOwnedDiffSummary,
  resolveTouchedFileWorkingTreeDiffStats,
  stripUntrustedSessionDiffSummary,
} from './sessionDiffStats'

describe('sessionDiffStats', () => {
  test('uses current working-tree totals only for explicitly attributed files', () => {
    expect(resolveTouchedFileWorkingTreeDiffStats(
      ['./src/owned.ts'],
      {
        'src/owned.ts': { insertions: 3, deletions: 1 },
        'src/unrelated.ts': { insertions: 50, deletions: 10 },
      },
    )).toEqual({ additions: 3, deletions: 1 })
  })

  test('hides attributed totals once those files are clean', () => {
    expect(resolveTouchedFileWorkingTreeDiffStats(['src/owned.ts'], {})).toBeNull()
    expect(resolveTouchedFileWorkingTreeDiffStats(['src/owned.ts'], undefined)).toBeNull()
  })

  test('strips untrusted session-level diff fields while preserving metadata', () => {
    const session = {
      id: 'ses_1',
      summary: {
        title: 'Preserved title',
        additions: 95,
        deletions: 3,
        files: 2,
        diffs: [{ file: 'src/unrelated.ts', additions: 95, deletions: 3 }],
      },
    }

    expect(stripUntrustedSessionDiffSummary(session)).toEqual({
      id: 'ses_1',
      summary: { title: 'Preserved title' },
    })
  })

  test('removes the summary when only untrusted diff fields remain', () => {
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

  test('normalization ignores user message summaries and patch-derived totals', () => {
    const session = {
      id: 'ses_1',
      summary: { title: 'Preserved title', additions: 95, deletions: 3 },
    }

    expect(normalizeChatOwnedDiffSummary(session, [
      { role: 'user', summary: { diffs: [{ file: 'src/unrelated.ts', additions: 2, deletions: 1 }] } },
    ])).toEqual({
      id: 'ses_1',
      summary: { title: 'Preserved title' },
    })
  })

  test('preserves identity when no untrusted summary fields exist', () => {
    const session = {
      id: 'ses_1',
      summary: { title: 'Preserved title' },
    }

    expect(normalizeChatOwnedDiffSummary(session, [])).toBe(session)
  })
})
