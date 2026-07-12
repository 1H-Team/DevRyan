import { describe, expect, it } from 'bun:test'

import {
  aggregateLiveSessions,
  aggregateLiveSessionStatuses,
  areSessionListsEquivalent,
  areStatusMapsEquivalent,
  findLiveSession,
  findLiveSessionStatus,
} from '../live-aggregate.ts'

const session = (id, directory, updated, extra = {}) => ({
  id,
  title: `${id}-title`,
  time: { created: updated - 1, updated, archived: undefined },
  directory,
  ...extra,
})

describe('live aggregate', () => {
  it('exposes the generated title from the freshest live session snapshot', () => {
    const states = [
      {
        session: [session('ses-1', '/a', 10, { title: 'Untitled Session' })],
        session_status: {},
      },
      {
        session: [session('ses-1', '/a', 25, { title: 'Fix OpenAI session titles' }), session('ses-2', '/b', 20)],
        session_status: {},
      },
    ]

    const sessions = aggregateLiveSessions(states)
    expect(sessions.map((item) => `${item.id}:${item.title}`)).toEqual([
      'ses-1:Fix OpenAI session titles',
      'ses-2:ses-2-title',
    ])
    expect(findLiveSession(states, 'ses-1')?.title).toBe('Fix OpenAI session titles')
  })

  it('prefers busy/retry statuses over stale idle snapshots', () => {
    const states = [
      {
        session: [],
        session_status: {
          'ses-1': { type: 'idle' },
          'ses-2': { type: 'idle' },
        },
      },
      {
        session: [],
        session_status: {
          'ses-1': { type: 'busy' },
          'ses-2': { type: 'retry', message: 'retrying' },
        },
      },
    ]

    const statuses = aggregateLiveSessionStatuses(states)
    expect(statuses['ses-1']?.type).toBe('busy')
    expect(statuses['ses-2']?.type).toBe('retry')
    expect(findLiveSessionStatus(states, 'ses-2')?.type).toBe('retry')
  })

  it('lets a fresher idle snapshot override a stale busy status', () => {
    const states = [
      {
        session: [session('ses-1', '/a', 10)],
        session_status: {
          'ses-1': { type: 'busy' },
        },
      },
      {
        session: [session('ses-1', '/a', 30)],
        session_status: {
          'ses-1': { type: 'idle' },
        },
      },
    ]

    const statuses = aggregateLiveSessionStatuses(states)
    expect(statuses['ses-1']?.type).toBe('idle')
    expect(findLiveSessionStatus(states, 'ses-1')?.type).toBe('idle')
  })

  it('detects retry metadata changes in status maps', () => {
    const retryStatus = { type: 'retry', message: 'retrying|server|message', attempt: 1, next: 100 }

    expect(areStatusMapsEquivalent(
      { 'ses-1': retryStatus },
      { 'ses-1': { ...retryStatus } },
    )).toBe(true)

    expect(areStatusMapsEquivalent(
      { 'ses-1': retryStatus },
      { 'ses-1': { ...retryStatus, attempt: 2, next: 200 } },
    )).toBe(false)
  })

  it('detects session summary-only changes in session lists', () => {
    const base = session('ses-1', '/a', 10, { summary: { additions: 1, deletions: 2 } })

    expect(areSessionListsEquivalent(
      [base],
      [{ ...base, summary: { additions: 3, deletions: 2 } }],
    )).toBe(false)

    expect(areSessionListsEquivalent(
      [base],
      [{ ...base, summary: { additions: 1, deletions: 2 } }],
    )).toBe(true)
  })
})
